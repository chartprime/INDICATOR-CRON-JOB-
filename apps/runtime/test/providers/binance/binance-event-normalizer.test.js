const {
  normalizeBinanceEvent,
  compareDecimalStrings,
  canonicalizeDecimalString,
  parseKlineRows,
  MAX_DECIMAL_STRING_LENGTH,
} = require("../../../src/providers/binance/binance-event-normalizer");
const { listAllowedCandleIntervals, candleIntervalMsFor } = require("../../../src/providers/binance/binance-config");

// Every raw payload below is a real message captured live against
// wss://stream.binance.com/stream (spot) and wss://fstream.binance.com
// /public|market/stream (USD-M) -- not invented shapes.
const REAL_SPOT_TRADE = {
  e: "trade", E: 1786444824142, s: "BTCUSDT", t: 6567786021,
  p: "64275.99000000", q: "0.00206000", T: 1786444824142, m: false, M: true,
};
const REAL_USDM_TRADE = {
  e: "trade", E: 1786449788005, T: 1786449788005, s: "BTCUSDT",
  t: 7965142954, p: "64403.00", q: "0.001", X: "MARKET", m: false, st: 1,
};
const REAL_SPOT_BOOK_TICKER = {
  u: 98429383442, s: "BTCUSDT", b: "64275.98000000", B: "7.01595000",
  a: "64275.99000000", A: "6.36383000",
};
const REAL_USDM_BOOK_TICKER = {
  e: "bookTicker", u: 11262433841676, s: "BTCUSDT", ps: "BTCUSDT",
  b: "64402.90", B: "7.040", a: "64403.00", A: "8.980",
  T: 1786449788005, E: 1786449788005, st: 1,
};
const REAL_SPOT_KLINE = {
  e: "kline", E: 1786449754019, s: "BTCUSDT",
  k: {
    t: 1786449720000, T: 1786449779999, s: "BTCUSDT", i: "1m",
    f: 6567844718, L: 6567845845, o: "64419.99000000", c: "64435.29000000",
    h: "64436.00000000", l: "64419.99000000", v: "5.72330000", n: 1128,
    x: false, q: "368753.75046110", V: "4.74895000", Q: "305973.44158110", B: "0",
  },
};
const REAL_USDM_KLINE = {
  e: "kline", E: 1786449788519, s: "BTCUSDT",
  k: {
    t: 1786449780000, T: 1786449839999, s: "BTCUSDT", i: "1m",
    f: 7965142894, L: 7965142955, o: "64402.90", c: "64402.90",
    h: "64403.00", l: "64402.90", v: "6.220", n: 57,
    x: false, q: "400586.11220", V: "0.742", Q: "47787.02600", B: "0",
  },
};
const REAL_SPOT_DEPTH = {
  e: "depthUpdate", E: 1786449753014, s: "BTCUSDT",
  U: 98430704567, u: 98430704720,
  b: [["64435.29000000", "2.23532000"], ["64431.48000000", "0.00000000"]],
  a: [["64435.30000000", "12.95311000"]],
};
// st (a real field on every live USD-M depth-diff message, confirmed by
// direct capture 2026-08-19) was missing from this fixture and from
// DEPTH_ALLOWED_KEYS -- every real PERPETUAL DEPTH event was silently
// rejected as malformed as a result, an outage that live verification
// only caught because SPOT DEPTH was the only thing ever live-tested
// before. Kept in the fixture from here on so this can't regress silently.
const REAL_USDM_DEPTH = {
  e: "depthUpdate", E: 1786449788013, T: 1786449788012, s: "BTCUSDT", ps: "BTCUSDT",
  U: 11262433826611, u: 11262433842415, pu: 11262433826542,
  b: [["1000.00", "184.309"], ["51522.30", "0.000"]],
  a: [["64403.00", "8.980"]],
  st: 1,
};

const RECEIVED_AT_MS = 1786449800000;

function normalize(marketKind, eventType, raw, interval) {
  return normalizeBinanceEvent(
    { marketKind, symbol: "BTCUSDT", eventType, interval, raw },
    { receivedAtMs: RECEIVED_AT_MS },
  );
}

describe("binance-event-normalizer", () => {
  describe("TRADE", () => {
    test("normalizes a real spot trade, using T (trade time) as eventTime", () => {
      const result = normalize("SPOT", "TRADE", REAL_SPOT_TRADE);
      expect(result).toEqual({
        provider: "BINANCE",
        venue: "BINANCE",
        marketKind: "SPOT",
        providerSymbol: "BTCUSDT",
        eventType: "TRADE",
        eventTime: new Date(1786444824142).toISOString(),
        receivedAt: new Date(RECEIVED_AT_MS).toISOString(),
        timingClass: "REALTIME",
        stale: false,
        recoveryState: "READY",
        payload: {
          tradeId: 6567786021,
          price: "64275.99000000",
          quantity: "0.00206000",
          isBuyerMaker: false,
        },
      });
    });

    test("normalizes a real USD-M trade despite its different trailing field set (X/st vs spot's M)", () => {
      const result = normalize("PERPETUAL", "TRADE", REAL_USDM_TRADE);
      expect(result.payload).toEqual({
        tradeId: 7965142954,
        price: "64403.00",
        quantity: "0.001",
        isBuyerMaker: false,
      });
      expect(result.marketKind).toBe("PERPETUAL");
    });

    test("preserves isBuyerMaker: true explicitly, not just truthy", () => {
      const buyerMakerTrade = { ...REAL_SPOT_TRADE, m: true };
      const result = normalize("SPOT", "TRADE", buyerMakerTrade);
      expect(result.payload.isBuyerMaker).toBe(true);
    });

    test("returns an UNAVAILABLE degraded state when the trade ID is missing", () => {
      const withoutTradeId = { ...REAL_SPOT_TRADE };
      delete withoutTradeId.t;
      const result = normalize("SPOT", "TRADE", withoutTradeId);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.missingFields).toContain("tradeId");
    });

    test("rejects a negative trade ID rather than accepting it as a usable integer", () => {
      const negativeTradeId = { ...REAL_SPOT_TRADE, t: -1 };
      const result = normalize("SPOT", "TRADE", negativeTradeId);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.missingFields).toContain("tradeId");
    });

    test("preserves price and quantity strings byte-for-byte, never round-tripped through Number", () => {
      const exactDecimal = { ...REAL_SPOT_TRADE, p: "64275.990000001", q: "0.10000000" };
      const result = normalize("SPOT", "TRADE", exactDecimal);
      expect(result.payload.price).toBe("64275.990000001");
      expect(result.payload.quantity).toBe("0.10000000");
    });

    test.each([
      ["price", { p: "0" }],
      ["quantity", { q: "0.000" }],
    ])("rejects a zero trade %s at the canonical boundary", (field, patch) => {
      const result = normalize("SPOT", "TRADE", { ...REAL_SPOT_TRADE, ...patch });
      expect(result).toMatchObject({
        state: "UNAVAILABLE",
        reason: "MISSING_OR_INVALID_REQUIRED_FIELD",
      });
      expect(result.missingFields).toContain(field);
    });

    test("returns an UNAVAILABLE degraded state when price is missing", () => {
      const withoutPrice = { ...REAL_SPOT_TRADE };
      delete withoutPrice.p;
      const result = normalize("SPOT", "TRADE", withoutPrice);
      expect(result).toEqual({
        provider: "BINANCE",
        venue: "BINANCE",
        marketKind: "SPOT",
        providerSymbol: "BTCUSDT",
        eventType: "TRADE",
        receivedAt: new Date(RECEIVED_AT_MS).toISOString(),
        timingClass: "REALTIME",
        stale: false,
        recoveryState: "READY",
        state: "UNAVAILABLE",
        reason: "MISSING_OR_INVALID_REQUIRED_FIELD",
        missingFields: ["price"],
      });
    });

    test("returns an UNAVAILABLE degraded state when the trade time is missing", () => {
      const withoutT = { ...REAL_SPOT_TRADE };
      delete withoutT.T;
      const result = normalize("SPOT", "TRADE", withoutT);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.missingFields).toContain("eventTime");
    });

    test("rejects a numeric price rather than coercing it through Number", () => {
      const numericPrice = { ...REAL_SPOT_TRADE, p: 64275.99 };
      const result = normalize("SPOT", "TRADE", numericPrice);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("MISSING_OR_INVALID_REQUIRED_FIELD");
      expect(result.missingFields).toContain("price");
    });

    test("returns an UNAVAILABLE degraded state when isBuyerMaker is missing", () => {
      const withoutAggressor = { ...REAL_SPOT_TRADE };
      delete withoutAggressor.m;
      const result = normalize("SPOT", "TRADE", withoutAggressor);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.missingFields).toContain("isBuyerMaker");
    });

    test("returns a deeply frozen envelope, not a mutable object a listener could corrupt", () => {
      const result = normalize("SPOT", "TRADE", REAL_SPOT_TRADE);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.payload)).toBe(true);
    });
  });

  describe("BOOK_TICKER", () => {
    test("normalizes a real USD-M book ticker using its own T as eventTime", () => {
      const result = normalize("PERPETUAL", "BOOK_TICKER", REAL_USDM_BOOK_TICKER);
      expect(result.eventTime).toBe(new Date(1786449788005).toISOString());
      expect(result.payload).toEqual({
        updateId: 11262433841676,
        bestBidPrice: "64402.90",
        bestBidQuantity: "7.040",
        bestAskPrice: "64403.00",
        bestAskQuantity: "8.980",
      });
    });

    test("falls back eventTime to receivedAt for spot book ticker, which carries no timestamp at all", () => {
      const result = normalize("SPOT", "BOOK_TICKER", REAL_SPOT_BOOK_TICKER);
      expect(result.eventTime).toBe(new Date(RECEIVED_AT_MS).toISOString());
      expect(result.payload).toEqual({
        updateId: 98429383442,
        bestBidPrice: "64275.98000000",
        bestBidQuantity: "7.01595000",
        bestAskPrice: "64275.99000000",
        bestAskQuantity: "6.36383000",
      });
    });

    test("uses E as eventTime when a USD-M book ticker is missing T but carries a usable E", () => {
      const withoutT = { ...REAL_USDM_BOOK_TICKER };
      delete withoutT.T;
      const result = normalize("PERPETUAL", "BOOK_TICKER", withoutT);
      expect(result.state).toBeUndefined();
      expect(result.eventTime).toBe(new Date(REAL_USDM_BOOK_TICKER.E).toISOString());
    });

    test("degrades rather than silently falling back when a book ticker carries a present-but-unusable timestamp", () => {
      const result = normalize("SPOT", "BOOK_TICKER", { ...REAL_SPOT_BOOK_TICKER, T: 0 });
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("MISSING_OR_INVALID_REQUIRED_FIELD");
      expect(result.missingFields).toContain("eventTime");
    });

    test("returns an UNAVAILABLE degraded state when the update ID is missing", () => {
      const withoutUpdateId = { ...REAL_SPOT_BOOK_TICKER };
      delete withoutUpdateId.u;
      const result = normalize("SPOT", "BOOK_TICKER", withoutUpdateId);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.missingFields).toContain("updateId");
    });

    test("returns an UNAVAILABLE degraded state when a required quote field is missing", () => {
      const withoutAsk = { ...REAL_SPOT_BOOK_TICKER };
      delete withoutAsk.a;
      const result = normalize("SPOT", "BOOK_TICKER", withoutAsk);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.missingFields).toContain("bestAskPrice");
    });
  });

  describe("KLINE", () => {
    test("normalizes a real spot kline, preserving isClosed and using outer E as eventTime", () => {
      const result = normalize("SPOT", "KLINE", REAL_SPOT_KLINE, "1m");
      expect(result.eventTime).toBe(new Date(1786449754019).toISOString());
      expect(result.payload).toEqual({
        interval: "1m",
        openTime: 1786449720000,
        closeTime: 1786449779999,
        open: "64419.99000000",
        close: "64435.29000000",
        high: "64436.00000000",
        low: "64419.99000000",
        baseVolume: "5.72330000",
        quoteVolume: "368753.75046110",
        takerBuyBaseVolume: "4.74895000",
        takerBuyQuoteVolume: "305973.44158110",
        numberOfTrades: 1128,
        isClosed: false,
      });
    });

    test("rejects zero OHLC values while retaining zero as valid for volume fields", () => {
      const invalid = normalize("SPOT", "KLINE", {
        ...REAL_SPOT_KLINE,
        k: { ...REAL_SPOT_KLINE.k, o: "0", h: "0", l: "0", c: "0", v: "0", q: "0", V: "0", Q: "0" },
      }, "1m");
      expect(invalid).toMatchObject({ state: "UNAVAILABLE", reason: "MISSING_OR_INVALID_REQUIRED_FIELD" });
      expect(invalid.missingFields).toEqual(expect.arrayContaining(["open", "close", "high", "low"]));
      expect(invalid.missingFields).not.toEqual(expect.arrayContaining(["baseVolume", "quoteVolume"]));
    });

    test("returns an UNAVAILABLE degraded state when a taker-buy volume field is missing", () => {
      const withoutTakerBuyBase = { ...REAL_SPOT_KLINE, k: { ...REAL_SPOT_KLINE.k } };
      delete withoutTakerBuyBase.k.V;
      const result = normalize("SPOT", "KLINE", withoutTakerBuyBase, "1m");
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.missingFields).toContain("takerBuyBaseVolume");
    });

    test("returns an UNAVAILABLE KLINE_TIME_RANGE_INVALID when closeTime does not come after openTime", () => {
      const invertedKline = {
        ...REAL_SPOT_KLINE,
        k: { ...REAL_SPOT_KLINE.k, t: REAL_SPOT_KLINE.k.T, T: REAL_SPOT_KLINE.k.t },
      };
      const result = normalize("SPOT", "KLINE", invertedKline, "1m");
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("KLINE_TIME_RANGE_INVALID");
    });

    test("refuses a well-formed kline of another interval on the subscription's stream", () => {
      const openTime = Math.floor(REAL_SPOT_KLINE.k.t / 300_000) * 300_000;
      const mislabelled = { ...REAL_SPOT_KLINE, k: { ...REAL_SPOT_KLINE.k, i: "5m", t: openTime, T: openTime + 299_999 } };
      const result = normalize("SPOT", "KLINE", mislabelled, "1m");
      expect(result.state).toBe("UNAVAILABLE");
      expect(normalize("SPOT", "KLINE", REAL_SPOT_KLINE, "1m").state).not.toBe("UNAVAILABLE");
    });

    test("returns an UNAVAILABLE KLINE_TIME_RANGE_INVALID when closeTime equals openTime (zero duration is never valid)", () => {
      const zeroDurationKline = {
        ...REAL_SPOT_KLINE,
        k: { ...REAL_SPOT_KLINE.k, T: REAL_SPOT_KLINE.k.t },
      };
      const result = normalize("SPOT", "KLINE", zeroDurationKline, "1m");
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("KLINE_TIME_RANGE_INVALID");
    });

    test("returns an UNAVAILABLE KLINE_OHLC_RANGE_INVALID when high is numerically below low", () => {
      const invertedOhlc = {
        ...REAL_SPOT_KLINE,
        k: { ...REAL_SPOT_KLINE.k, h: REAL_SPOT_KLINE.k.l, l: REAL_SPOT_KLINE.k.h },
      };
      const result = normalize("SPOT", "KLINE", invertedOhlc, "1m");
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("KLINE_OHLC_RANGE_INVALID");
    });

    test("returns an UNAVAILABLE KLINE_VOLUME_RANGE_INVALID when taker-buy volume exceeds the bar total", () => {
      const baseOverflow = {
        ...REAL_SPOT_KLINE,
        k: { ...REAL_SPOT_KLINE.k, V: "9.00000000" },
      };
      const quoteOverflow = {
        ...REAL_SPOT_KLINE,
        k: { ...REAL_SPOT_KLINE.k, Q: "999999.00000000" },
      };
      expect(normalize("SPOT", "KLINE", baseOverflow, "1m").reason).toBe("KLINE_VOLUME_RANGE_INVALID");
      expect(normalize("SPOT", "KLINE", quoteOverflow, "1m").reason).toBe("KLINE_VOLUME_RANGE_INVALID");
    });

    test("returns an UNAVAILABLE KLINE_OHLC_RANGE_INVALID when open or close lies outside high/low", () => {
      const openAboveHigh = {
        ...REAL_SPOT_KLINE,
        k: { ...REAL_SPOT_KLINE.k, o: "64437.00" },
      };
      const closeBelowLow = {
        ...REAL_SPOT_KLINE,
        k: { ...REAL_SPOT_KLINE.k, c: "64419.98" },
      };

      expect(normalize("SPOT", "KLINE", openAboveHigh, "1m").reason).toBe("KLINE_OHLC_RANGE_INVALID");
      expect(normalize("SPOT", "KLINE", closeBelowLow, "1m").reason).toBe("KLINE_OHLC_RANGE_INVALID");
    });

    test("returns an UNAVAILABLE KLINE_TIME_RANGE_INVALID when the wire interval and timestamps disagree", () => {
      const wrongDuration = {
        ...REAL_SPOT_KLINE,
        k: { ...REAL_SPOT_KLINE.k, T: REAL_SPOT_KLINE.k.T - 1 },
      };
      const result = normalize("SPOT", "KLINE", wrongDuration, "1m");
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("KLINE_TIME_RANGE_INVALID");
    });

    test("rejects a duration-correct kline whose open time is not aligned to its declared interval", () => {
      const openTime = REAL_SPOT_KLINE.k.t + 1;
      const unaligned = {
        ...REAL_SPOT_KLINE,
        k: { ...REAL_SPOT_KLINE.k, t: openTime, T: openTime + 59_999 },
      };
      const result = normalize("SPOT", "KLINE", unaligned, "1m");
      expect(result).toMatchObject({ state: "UNAVAILABLE", reason: "KLINE_TIME_RANGE_INVALID" });
    });

    test("accepts a flat kline whose high equals low even when the decimal strings differ only by trailing zeros", () => {
      const flatKline = {
        ...REAL_SPOT_KLINE,
        k: { ...REAL_SPOT_KLINE.k, h: "64420.00", l: "64420.0", o: "64420.00", c: "64420.00" },
      };
      const result = normalize("SPOT", "KLINE", flatKline, "1m");
      expect(result.state).toBeUndefined();
      expect(result.payload.high).toBe("64420.00");
      expect(result.payload.low).toBe("64420.0");
    });

    test("normalizes a real USD-M kline identically in shape to spot's", () => {
      const result = normalize("PERPETUAL", "KLINE", REAL_USDM_KLINE, "1m");
      expect(result.payload.isClosed).toBe(false);
      expect(result.payload.open).toBe("64402.90");
    });

    test("preserves isClosed: true explicitly, not just truthy", () => {
      const closedKline = { ...REAL_SPOT_KLINE, k: { ...REAL_SPOT_KLINE.k, x: true } };
      const result = normalize("SPOT", "KLINE", closedKline, "1m");
      expect(result.payload.isClosed).toBe(true);
    });

    test("returns an UNAVAILABLE degraded state when the nested k object is missing", () => {
      const withoutK = { ...REAL_SPOT_KLINE };
      delete withoutK.k;
      const result = normalize("SPOT", "KLINE", withoutK, "1m");
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("MALFORMED_RAW_MESSAGE");
    });

    test("returns an UNAVAILABLE degraded state when the nested k object is a hostile Proxy", () => {
      const hostileKline = { ...REAL_SPOT_KLINE, k: new Proxy(REAL_SPOT_KLINE.k, {}) };
      const result = normalize("SPOT", "KLINE", hostileKline, "1m");
      expect(result.state).toBe("UNAVAILABLE");
    });

    test("throws on a missing caller-side KLINE interval because that is a programming-contract violation", () => {
      expect(() => normalize("SPOT", "KLINE", REAL_SPOT_KLINE, undefined)).toThrow(/invalid interval/);
    });

    test("returns an UNAVAILABLE degraded state when Binance's own k.i is missing, rather than painting the subscribed interval as if it came off the wire", () => {
      const withoutWireInterval = { ...REAL_SPOT_KLINE, k: { ...REAL_SPOT_KLINE.k } };
      delete withoutWireInterval.k.i;
      const result = normalize("SPOT", "KLINE", withoutWireInterval, "1m");
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("MISSING_OR_INVALID_REQUIRED_FIELD");
      expect(result.missingFields).toContain("interval");
    });

    test("payload.interval is Binance's own k.i, proven equal to the subscription, not a copy of the subscription alone", () => {
      const result = normalize("SPOT", "KLINE", REAL_SPOT_KLINE, "1m");
      expect(result.payload.interval).toBe(REAL_SPOT_KLINE.k.i);
      expect(result.payload.interval).toBe("1m");
    });

    test("normalizes every allowlisted kline interval when its wire timestamps match the subscription", () => {
      for (const interval of listAllowedCandleIntervals()) {
        const intervalMs = candleIntervalMsFor(interval);
        const openTime = Math.floor(REAL_SPOT_KLINE.k.t / intervalMs) * intervalMs;
        const raw = {
          ...REAL_SPOT_KLINE,
          k: { ...REAL_SPOT_KLINE.k, i: interval, t: openTime, T: openTime + intervalMs - 1 },
        };
        const result = normalize("SPOT", "KLINE", raw, interval);
        expect(result.state).toBeUndefined();
        expect(result.payload.interval).toBe(interval);
      }
    });

    test("returns an UNAVAILABLE INTERVAL_MISMATCH when Binance's own k.i disagrees with the subscribed interval, rather than silently trusting either one", () => {
      const result = normalize("SPOT", "KLINE", REAL_SPOT_KLINE, "5m");
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("INTERVAL_MISMATCH");
    });
  });

  describe("DEPTH", () => {
    test("normalizes real spot depth: previousUpdateId is explicitly null (not missing), no pu field exists on spot", () => {
      const result = normalize("SPOT", "DEPTH", REAL_SPOT_DEPTH);
      expect(result.eventTime).toBe(new Date(1786449753014).toISOString());
      expect(result.payload.previousUpdateId).toBeNull();
      expect(result.payload.firstUpdateId).toBe(98430704567);
      expect(result.payload.lastUpdateId).toBe(98430704720);
    });

    test("normalizes real USD-M depth using T (transaction time), and carries the real pu chain field", () => {
      const result = normalize("PERPETUAL", "DEPTH", REAL_USDM_DEPTH);
      expect(result.eventTime).toBe(new Date(1786449788012).toISOString());
      expect(result.payload.previousUpdateId).toBe(11262433826542);
    });

    test("accepts the real st field on USD-M depth events rather than rejecting the whole event as an unrecognized key -- regression: this exact gap made every live PERPETUAL DEPTH event UNAVAILABLE, confirmed by direct live capture", () => {
      const result = normalize("PERPETUAL", "DEPTH", { ...REAL_USDM_DEPTH, st: 1 });
      expect(result.state).toBeUndefined();
      expect(result.payload.lastUpdateId).toBe(11262433842415);
    });

    test("rejects a negative firstUpdateId rather than accepting it as a usable integer", () => {
      const negativeU = { ...REAL_SPOT_DEPTH, U: -1 };
      const result = normalize("SPOT", "DEPTH", negativeU);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.missingFields).toContain("firstUpdateId");
    });

    test("returns an UNAVAILABLE UPDATE_ID_RANGE_INVALID when lastUpdateId is before firstUpdateId", () => {
      const invertedRange = { ...REAL_SPOT_DEPTH, U: REAL_SPOT_DEPTH.u, u: REAL_SPOT_DEPTH.U };
      const result = normalize("SPOT", "DEPTH", invertedRange);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("UPDATE_ID_RANGE_INVALID");
    });

    test("accepts lastUpdateId equal to firstUpdateId (a single-update message is valid)", () => {
      const singleUpdate = { ...REAL_SPOT_DEPTH, U: REAL_SPOT_DEPTH.U, u: REAL_SPOT_DEPTH.U };
      const result = normalize("SPOT", "DEPTH", singleUpdate);
      expect(result.state).toBeUndefined();
      expect(result.payload.lastUpdateId).toBe(result.payload.firstUpdateId);
    });

    test("returns an UNAVAILABLE degraded state when USD-M depth is missing pu (spot's null is not reused for perpetual)", () => {
      const withoutPu = { ...REAL_USDM_DEPTH };
      delete withoutPu.pu;
      const result = normalize("PERPETUAL", "DEPTH", withoutPu);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.missingFields).toContain("previousUpdateId");
    });

    test("preserves a zero-quantity entry (a price-level deletion), not treating it as invalid or dropping it", () => {
      const result = normalize("SPOT", "DEPTH", REAL_SPOT_DEPTH);
      expect(result.payload.bids).toContainEqual(["64431.48000000", "0.00000000"]);
    });

    test("accepts an empty bids or asks array as valid, not as a missing-field failure", () => {
      const noBids = { ...REAL_SPOT_DEPTH, b: [] };
      const result = normalize("SPOT", "DEPTH", noBids);
      expect(result.state).not.toBe("UNAVAILABLE");
      expect(result.payload.bids).toEqual([]);
    });

    test("rejects a depth message whose bid/ask entry is not an exact 2-tuple of decimal strings", () => {
      const hostileDepth = { ...REAL_SPOT_DEPTH, b: [["64435.29000000", "2.0", "extra"]] };
      const result = normalize("SPOT", "DEPTH", hostileDepth);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("MALFORMED_RAW_MESSAGE");
    });

    test("never invokes a getter defined on a tuple entry's own price/quantity index, rejecting it instead", () => {
      let reads = 0;
      const hostileEntry = [];
      Object.defineProperty(hostileEntry, "0", {
        enumerable: true,
        configurable: true,
        get() {
          reads += 1;
          return "64435.29000000";
        },
      });
      Object.defineProperty(hostileEntry, "1", { value: "2.0", enumerable: true, configurable: true });
      const hostileDepth = { ...REAL_SPOT_DEPTH, b: [hostileEntry] };
      const result = normalize("SPOT", "DEPTH", hostileDepth);
      expect(reads).toBe(0);
      expect(result.state).toBe("UNAVAILABLE");
    });

    test("never invokes a getter defined on the bids/asks array's own element index, rejecting it instead", () => {
      let reads = 0;
      const hostileArray = [];
      hostileArray.length = 1;
      Object.defineProperty(hostileArray, "0", {
        enumerable: true,
        configurable: true,
        get() {
          reads += 1;
          return ["64435.29000000", "2.0"];
        },
      });
      const hostileDepth = { ...REAL_SPOT_DEPTH, b: hostileArray };
      const result = normalize("SPOT", "DEPTH", hostileDepth);
      expect(reads).toBe(0);
      expect(result.state).toBe("UNAVAILABLE");
    });

    test("rejects a negative quantity rather than silently accepting it as a valid decimal string", () => {
      const negativeQty = { ...REAL_SPOT_DEPTH, b: [["64435.29000000", "-2.0"]] };
      const result = normalize("SPOT", "DEPTH", negativeQty);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("MALFORMED_RAW_MESSAGE");
    });

    test("rejects a negative price the same way", () => {
      const negativePrice = { ...REAL_SPOT_DEPTH, b: [["-64435.29000000", "2.0"]] };
      const result = normalize("SPOT", "DEPTH", negativePrice);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("MALFORMED_RAW_MESSAGE");
    });

    test("rejects a depth message whose bids array exceeds the bound rather than accepting it unbounded", () => {
      const oversized = { ...REAL_SPOT_DEPTH, b: Array.from({ length: 5001 }, () => ["1.0", "1.0"]) };
      const result = normalize("SPOT", "DEPTH", oversized);
      expect(result.state).toBe("UNAVAILABLE");
    });

    test("bounds decimal token length before a hostile provider value can be retained in canonical state or storage", () => {
      const oversizedPrice = "1".repeat(MAX_DECIMAL_STRING_LENGTH + 1);
      const result = normalize("SPOT", "TRADE", { ...REAL_SPOT_TRADE, p: oversizedPrice });
      expect(result).toMatchObject({
        state: "UNAVAILABLE",
        reason: "MISSING_OR_INVALID_REQUIRED_FIELD",
        missingFields: ["price"],
      });
    });

    test("accepts exactly the maximum bound (5000 entries), the boundary-exact case, not just comfortably-under or one-over", () => {
      const atBound = { ...REAL_SPOT_DEPTH, b: Array.from({ length: 5000 }, () => ["1.0", "1.0"]) };
      const result = normalize("SPOT", "DEPTH", atBound);
      expect(result.state).toBeUndefined();
      expect(result.payload.bids).toHaveLength(5000);
    });
  });

  describe("hostile input", () => {
    test("rejects a Proxy-wrapped raw message outright", () => {
      const result = normalize("SPOT", "TRADE", new Proxy(REAL_SPOT_TRADE, {}));
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("MALFORMED_RAW_MESSAGE");
    });

    test("never invokes an accessor-defined field on the raw message, rejecting it instead", () => {
      let reads = 0;
      const hostile = { e: "trade", E: 1786444824142, s: "BTCUSDT", t: 1, q: "1.0", T: 1786444824142, m: false };
      Object.defineProperty(hostile, "p", {
        enumerable: true,
        configurable: true,
        get() {
          reads += 1;
          return "64275.99000000";
        },
      });
      const result = normalize("SPOT", "TRADE", hostile);
      expect(reads).toBe(0);
      expect(result.state).toBe("UNAVAILABLE");
    });

    test("rejects a raw message carrying a non-enumerable own data field, not just accessor-defined ones", () => {
      const hostile = { e: "trade", E: 1786444824142, s: "BTCUSDT", t: 1, q: "1.0", T: 1786444824142, m: false };
      Object.defineProperty(hostile, "p", {
        value: "64275.99000000", enumerable: false, configurable: true,
      });
      const result = normalize("SPOT", "TRADE", hostile);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("MALFORMED_RAW_MESSAGE");
    });

    test("rejects a raw message carrying an unexpected extra field", () => {
      const result = normalize("SPOT", "TRADE", { ...REAL_SPOT_TRADE, unexpectedField: "x" });
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("MALFORMED_RAW_MESSAGE");
    });

    test("rejects a non-object raw message", () => {
      expect(normalize("SPOT", "TRADE", "not an object").state).toBe("UNAVAILABLE");
      expect(normalize("SPOT", "TRADE", null).state).toBe("UNAVAILABLE");
      expect(normalize("SPOT", "TRADE", ["array"]).state).toBe("UNAVAILABLE");
    });

    test("throws on an unrecognized caller-side eventType before touching the raw payload", () => {
      expect(() => normalize("SPOT", "MARK_PRICE", REAL_SPOT_TRADE)).toThrow(/invalid identity/);
    });

    test("rejects a timestamp beyond Date's representable range rather than producing an unrepresentable eventTime", () => {
      const hostile = { ...REAL_SPOT_TRADE, T: 9e20 };
      const result = normalize("SPOT", "TRADE", hostile);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("MISSING_OR_INVALID_REQUIRED_FIELD");
      expect(result.missingFields).toContain("eventTime");
    });

    test("fails closed rather than throwing when the raw message is a revoked Proxy", () => {
      const { proxy, revoke } = Proxy.revocable(REAL_SPOT_TRADE, {});
      revoke();
      let result;
      expect(() => {
        result = normalize("SPOT", "TRADE", proxy);
      }).not.toThrow();
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("MALFORMED_RAW_MESSAGE");
    });

    test("fails closed rather than throwing when a depth bids array is a revoked Proxy", () => {
      const { proxy, revoke } = Proxy.revocable(REAL_SPOT_DEPTH.b, {});
      revoke();
      const hostile = { ...REAL_SPOT_DEPTH, b: proxy };
      let result;
      expect(() => {
        result = normalize("SPOT", "DEPTH", hostile);
      }).not.toThrow();
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("MALFORMED_RAW_MESSAGE");
    });

    test("fails closed rather than throwing when a single depth bids entry is a revoked Proxy", () => {
      const { proxy, revoke } = Proxy.revocable(REAL_SPOT_DEPTH.b[0], {});
      revoke();
      const hostile = { ...REAL_SPOT_DEPTH, b: [proxy, REAL_SPOT_DEPTH.b[1]] };
      let result;
      expect(() => {
        result = normalize("SPOT", "DEPTH", hostile);
      }).not.toThrow();
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("MALFORMED_RAW_MESSAGE");
    });
  });

  describe("stream/raw symbol binding", () => {
    test("rejects a trade whose raw s disagrees with the subscribed stream's symbol", () => {
      const spoofed = { ...REAL_SPOT_TRADE, s: "ETHUSDT" };
      const result = normalizeBinanceEvent(
        { marketKind: "SPOT", symbol: "BTCUSDT", eventType: "TRADE", raw: spoofed },
        { receivedAtMs: RECEIVED_AT_MS },
      );
      expect(result).toEqual({
        provider: "BINANCE",
        venue: "BINANCE",
        marketKind: "SPOT",
        providerSymbol: "BTCUSDT",
        eventType: "TRADE",
        receivedAt: new Date(RECEIVED_AT_MS).toISOString(),
        timingClass: "REALTIME",
        stale: false,
        recoveryState: "READY",
        state: "UNAVAILABLE",
        reason: "STREAM_SYMBOL_MISMATCH",
        missingFields: [],
      });
    });

    test("rejects a book ticker, kline, and depth event the same way", () => {
      expect(
        normalize("SPOT", "BOOK_TICKER", { ...REAL_SPOT_BOOK_TICKER, s: "ETHUSDT" }).reason,
      ).toBe("STREAM_SYMBOL_MISMATCH");
      expect(
        normalize("SPOT", "KLINE", { ...REAL_SPOT_KLINE, s: "ETHUSDT" }, "1m").reason,
      ).toBe("STREAM_SYMBOL_MISMATCH");
      expect(
        normalize("SPOT", "DEPTH", { ...REAL_SPOT_DEPTH, s: "ETHUSDT" }).reason,
      ).toBe("STREAM_SYMBOL_MISMATCH");
    });

    test("rejects a kline whose outer s matches the stream but nested k.s disagrees", () => {
      const spoofed = { ...REAL_SPOT_KLINE, k: { ...REAL_SPOT_KLINE.k, s: "ETHUSDT" } };
      const result = normalize("SPOT", "KLINE", spoofed, "1m");
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("STREAM_SYMBOL_MISMATCH");
    });

    test("still normalizes a kline cleanly when outer s and nested k.s both match (no regression)", () => {
      const result = normalize("SPOT", "KLINE", REAL_SPOT_KLINE, "1m");
      expect(result.state).toBeUndefined();
      expect(result.providerSymbol).toBe("BTCUSDT");
    });

    test("rejects a raw payload missing s entirely rather than treating it as unbound", () => {
      const withoutSymbol = { ...REAL_SPOT_TRADE };
      delete withoutSymbol.s;
      const result = normalize("SPOT", "TRADE", withoutSymbol);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("STREAM_SYMBOL_MISMATCH");
    });

    test("still normalizes cleanly when raw s matches the subscribed symbol (no regression)", () => {
      const result = normalize("SPOT", "TRADE", REAL_SPOT_TRADE);
      expect(result.state).toBeUndefined();
      expect(result.providerSymbol).toBe("BTCUSDT");
    });
  });

  describe("provider event type binding", () => {
    test("rejects a trade-shaped payload whose e disagrees with the expected wire event type", () => {
      const spoofed = { ...REAL_SPOT_TRADE, e: "bookTicker" };
      const result = normalize("SPOT", "TRADE", spoofed);
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("PROVIDER_EVENT_TYPE_MISMATCH");
    });

    test("rejects a book ticker, kline, and depth event the same way when e disagrees", () => {
      expect(
        normalize("PERPETUAL", "BOOK_TICKER", { ...REAL_USDM_BOOK_TICKER, e: "trade" }).reason,
      ).toBe("PROVIDER_EVENT_TYPE_MISMATCH");
      expect(
        normalize("SPOT", "KLINE", { ...REAL_SPOT_KLINE, e: "trade" }, "1m").reason,
      ).toBe("PROVIDER_EVENT_TYPE_MISMATCH");
      expect(
        normalize("SPOT", "DEPTH", { ...REAL_SPOT_DEPTH, e: "trade" }).reason,
      ).toBe("PROVIDER_EVENT_TYPE_MISMATCH");
    });

    test("spot book ticker, which never carries e at all, is not rejected for its absence", () => {
      const result = normalize("SPOT", "BOOK_TICKER", REAL_SPOT_BOOK_TICKER);
      expect(result.state).toBeUndefined();
    });

    test("USD-M book ticker, whose e is present and correct, normalizes cleanly (no regression)", () => {
      const result = normalize("PERPETUAL", "BOOK_TICKER", REAL_USDM_BOOK_TICKER);
      expect(result.state).toBeUndefined();
    });
  });

  describe("compareDecimalStrings", () => {
    test("treats equal values as equal regardless of leading/trailing zero formatting", () => {
      expect(compareDecimalStrings("1.5", "1.5")).toBe(0);
      expect(compareDecimalStrings("01.50", "1.5")).toBe(0);
      expect(compareDecimalStrings("0", "0.0")).toBe(0);
      expect(compareDecimalStrings("0", "00")).toBe(0);
    });

    test("compares by integer-part length first", () => {
      expect(compareDecimalStrings("100.0", "99.9")).toBe(1);
      expect(compareDecimalStrings("99.9", "100.0")).toBe(-1);
    });

    test("compares fractional parts of unequal length correctly", () => {
      expect(compareDecimalStrings("1.5", "1.499999")).toBe(1);
      expect(compareDecimalStrings("1.499999", "1.5")).toBe(-1);
      expect(compareDecimalStrings("1.50", "1.5")).toBe(0);
    });

    test("a valid non-zero decimal far smaller than Number's precision floor still compares greater than zero", () => {
      const tiny = `0.${"0".repeat(400)}1`;
      expect(compareDecimalStrings(tiny, "0")).toBe(1);
      expect(compareDecimalStrings("0", tiny)).toBe(-1);
      // The exact failure mode this guards against: Number() underflows it to 0.
      expect(Number(tiny)).toBe(0);
    });

    test("preserves ordering for values with more significant digits than Number's safe precision", () => {
      const a = "12345678901234567890.1";
      const b = "12345678901234567890.2";
      expect(compareDecimalStrings(a, b)).toBe(-1);
      expect(compareDecimalStrings(b, a)).toBe(1);
    });
  });

  describe("canonicalizeDecimalString", () => {
    test("is the identity class of compareDecimalStrings: equal values share one key, unequal values do not", () => {
      const pairs = [
        ["1.5", "1.5"],
        ["01.50", "1.5"],
        ["0", "0.0"],
        ["0", "00"],
        ["1.50", "1.5"],
        ["50.00", "50.0"],
      ];
      for (const [a, b] of pairs) {
        expect(compareDecimalStrings(a, b)).toBe(0);
        expect(canonicalizeDecimalString(a)).toBe(canonicalizeDecimalString(b));
      }
      expect(canonicalizeDecimalString("1.5")).not.toBe(canonicalizeDecimalString("1.499999"));
      expect(canonicalizeDecimalString("100.0")).not.toBe(canonicalizeDecimalString("99.9"));
    });
  });

  describe("stale and recoveryState pass-through", () => {
    test("carries provisional stale/recoveryState values through verbatim from the caller", () => {
      const result = normalizeBinanceEvent(
        { marketKind: "SPOT", symbol: "BTCUSDT", eventType: "TRADE", raw: REAL_SPOT_TRADE },
        { receivedAtMs: RECEIVED_AT_MS, stale: true, recoveryState: "RECOVERING" },
      );
      expect(result.stale).toBe(true);
      expect(result.recoveryState).toBe("RECOVERING");
    });

    test("defaults to stale: false and recoveryState: READY when the caller omits them", () => {
      const result = normalizeBinanceEvent(
        { marketKind: "SPOT", symbol: "BTCUSDT", eventType: "TRADE", raw: REAL_SPOT_TRADE },
        { receivedAtMs: RECEIVED_AT_MS },
      );
      expect(result.stale).toBe(false);
      expect(result.recoveryState).toBe("READY");
    });

    test("rejects an unusable caller-supplied receivedAtMs instead of silently replacing timing evidence", () => {
      expect(() => normalizeBinanceEvent(
        { marketKind: "SPOT", symbol: "BTCUSDT", eventType: "TRADE", raw: REAL_SPOT_TRADE },
        { receivedAtMs: Number.NaN },
      )).toThrow(/invalid receivedAtMs/);
    });

    test.each([
      [{ stale: "false" }, /invalid health fields/],
      [{ recoveryState: "UNKNOWN" }, /invalid health fields/],
      [{ stale: false, recoveryState: "RECOVERING" }, /requires stale: true/],
    ])("rejects inconsistent caller health metadata: %j", (health, expected) => {
      expect(() => normalizeBinanceEvent(
        { marketKind: "SPOT", symbol: "BTCUSDT", eventType: "TRADE", raw: REAL_SPOT_TRADE },
        { receivedAtMs: RECEIVED_AT_MS, ...health },
      )).toThrow(expected);
    });

    test("a degraded envelope from normalizeBinanceEvent's own pre-buildEnvelope checks still carries provider, venue, timing, and the caller's stale/recoveryState, not a partial object", () => {
      const result = normalizeBinanceEvent(
        { marketKind: "SPOT", symbol: "BTCUSDT", eventType: "TRADE", raw: new Proxy(REAL_SPOT_TRADE, {}) },
        { receivedAtMs: RECEIVED_AT_MS, stale: true, recoveryState: "RECOVERING" },
      );
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("MALFORMED_RAW_MESSAGE");
      expect(result.provider).toBe("BINANCE");
      expect(result.venue).toBe("BINANCE");
      expect(result.marketKind).toBe("SPOT");
      expect(result.providerSymbol).toBe("BTCUSDT");
      expect(result.timingClass).toBe("REALTIME");
      expect(result.receivedAt).toBe(new Date(RECEIVED_AT_MS).toISOString());
      expect(result.stale).toBe(true);
      expect(result.recoveryState).toBe("RECOVERING");
    });

    test("a degraded envelope from a buildEnvelope-level check (KLINE interval mismatch) also carries the same fields", () => {
      const result = normalize("SPOT", "KLINE", REAL_SPOT_KLINE, "5m");
      expect(result.state).toBe("UNAVAILABLE");
      expect(result.reason).toBe("INTERVAL_MISMATCH");
      expect(result.venue).toBe("BINANCE");
      expect(result.timingClass).toBe("REALTIME");
      expect(result.receivedAt).toBe(new Date(RECEIVED_AT_MS).toISOString());
      expect(result.stale).toBe(false);
      expect(result.recoveryState).toBe("READY");
    });
  });

  describe("parseKlineRows (REST /klines backfill)", () => {
    // Binance's real REST kline row shape: [openTime, open, high, low,
    // close, volume, closeTime, quoteVolume, numberOfTrades,
    // takerBuyBaseVolume, takerBuyQuoteVolume, ignore].
    function realRow(openTime, overrides = {}) {
      const base = [
        openTime, "64200.00", "64300.50", "64150.25", "64275.99", "12.34500000",
        openTime + 59_999, "792345.11", 418, "6.0", "385000.0", "0",
      ];
      for (const [index, value] of Object.entries(overrides)) {
        base[Number(index)] = value;
      }
      return base;
    }

    test("parses a real-shaped page of rows correctly", () => {
      const rows = [realRow(1_700_000_000_000), realRow(1_700_000_060_000)];
      const result = parseKlineRows(rows);
      expect(result).toEqual([
        {
          openTime: 1_700_000_000_000,
          open: "64200.00",
          high: "64300.50",
          low: "64150.25",
          close: "64275.99",
          volume: "12.34500000",
          closeTime: 1_700_000_059_999,
          quoteVolume: "792345.11",
          numberOfTrades: 418,
          takerBuyBaseVolume: "6.0",
          takerBuyQuoteVolume: "385000.0",
        },
        {
          openTime: 1_700_000_060_000,
          open: "64200.00",
          high: "64300.50",
          low: "64150.25",
          close: "64275.99",
          volume: "12.34500000",
          closeTime: 1_700_000_119_999,
          quoteVolume: "792345.11",
          numberOfTrades: 418,
          takerBuyBaseVolume: "6.0",
          takerBuyQuoteVolume: "385000.0",
        },
      ]);
    });

    test("requires the exact documented 12-field Binance REST kline row", () => {
      expect(parseKlineRows([realRow(1_700_000_000_000).slice(0, 11)])).toBeNull();
      expect(parseKlineRows([[...realRow(1_700_000_000_000), "unexpected"]])).toBeNull();
    });

    test("rejects a row shorter than the minimum required length -- taker-buy volume is required, not an optional trailing field", () => {
      const row = realRow(1_700_000_000_000).slice(0, 9);
      expect(parseKlineRows([row])).toBeNull();
    });

    test("an empty page is valid -- zero rows, not malformed", () => {
      expect(parseKlineRows([])).toEqual([]);
    });

    test.each([
      ["not an array", { notAnArray: true }],
      ["null", null],
      ["a string", "[]"],
      ["a Proxy-wrapped array", new Proxy([], {})],
    ])("rejects the whole page when the top level is %s", (_label, input) => {
      expect(parseKlineRows(input)).toBeNull();
    });

    test("rejects the whole page when one row is not itself an array", () => {
      expect(parseKlineRows([realRow(1_700_000_000_000), "not-a-row"])).toBeNull();
    });

    test("rejects the whole page when one row is shorter than the minimum required length", () => {
      const shortRow = realRow(1_700_000_000_000).slice(0, 8);
      expect(parseKlineRows([realRow(1_700_000_000_000), shortRow])).toBeNull();
    });

    test("rejects the whole page when one row has a sparse hole at a required index", () => {
      const holedRow = realRow(1_700_000_000_000);
      delete holedRow[2]; // high
      expect(parseKlineRows([holedRow])).toBeNull();
    });

    test.each([
      ["openTime is not a usable timestamp", 0, -1],
      ["openTime is not a usable timestamp", 0, "1700000000000"],
      ["closeTime is not a usable timestamp", 6, null],
      ["open is not a valid decimal string", 1, "not-a-number"],
      ["high is not a valid decimal string", 2, 64300.5],
      ["low is not a valid decimal string", 3, "-1.0"],
      ["close is not a valid decimal string", 4, ""],
      ["volume is not a valid decimal string", 5, "1e10"],
      ["quoteVolume is not a valid decimal string", 7, "1e10"],
      ["numberOfTrades is not a non-negative integer", 8, -1],
      ["numberOfTrades is not a non-negative integer", 8, 4.5],
      ["takerBuyBaseVolume is not a valid decimal string", 9, "not-a-number"],
      ["takerBuyBaseVolume is negative", 9, "-1.0"],
      ["takerBuyQuoteVolume is not a valid decimal string", 10, "not-a-number"],
    ])("rejects the whole page when a field is invalid: %s", (_label, index, badValue) => {
      const rows = [realRow(1_700_000_000_000, { [index]: badValue })];
      expect(parseKlineRows(rows)).toBeNull();
    });

    test("rejects a row whose takerBuyBaseVolume exceeds its own volume", () => {
      const row = realRow(1_700_000_000_000, { 5: "10", 9: "10.0001" });
      expect(parseKlineRows([row])).toBeNull();
    });

    test("rejects a row whose takerBuyQuoteVolume exceeds its own quoteVolume", () => {
      const row = realRow(1_700_000_000_000, { 7: "100", 10: "100.0001" });
      expect(parseKlineRows([row])).toBeNull();
    });

    test("accepts a row whose takerBuyBaseVolume exactly equals its own volume -- the all-buy boundary", () => {
      const row = realRow(1_700_000_000_000, { 5: "10", 9: "10" });
      const [parsed] = parseKlineRows([row]);
      expect(parsed.takerBuyBaseVolume).toBe("10");
    });

    test("rejects a row whose closeTime does not come after its openTime", () => {
      const rows = [realRow(1_700_000_000_000, { 6: 1_700_000_000_000 })];
      expect(parseKlineRows(rows)).toBeNull();
    });

    test("rejects a row whose high is below its low", () => {
      const rows = [realRow(1_700_000_000_000, { 2: "100.00", 3: "200.00" })];
      expect(parseKlineRows(rows)).toBeNull();
    });

    test("rejects a row whose open or close lies outside high/low", () => {
      expect(parseKlineRows([realRow(1_700_000_000_000, { 1: "70000.00" })])).toBeNull();
      expect(parseKlineRows([realRow(1_700_000_000_000, { 4: "60000.00" })])).toBeNull();
    });

    test("rejects duplicate or reverse-ordered REST rows", () => {
      const first = realRow(1_700_000_000_000);
      const second = realRow(1_700_000_060_000);
      expect(parseKlineRows([first, first])).toBeNull();
      expect(parseKlineRows([second, first])).toBeNull();
    });

    test("rejects an internal candle gap when an expected interval is supplied", () => {
      const first = realRow(1_700_000_000_000);
      const afterGap = realRow(1_700_000_120_000);
      expect(parseKlineRows([first, afterGap], 60_000)).toBeNull();
    });

    test("enforces an expected REST interval when supplied", () => {
      expect(parseKlineRows([realRow(1_800_000_000_000)], 60_000)).not.toBeNull();
      expect(parseKlineRows([realRow(1_800_000_000_000)], 300_000)).toBeNull();
    });

    test("rejects a duration-correct REST row that is off the requested interval grid", () => {
      expect(parseKlineRows([realRow(1_700_000_000_001)], 60_000)).toBeNull();
    });

    test("one malformed row invalidates the whole page, not just that row -- never a silently-filtered subset", () => {
      const goodRow = realRow(1_700_000_000_000);
      const badRow = realRow(1_700_000_060_000, { 1: "not-a-number" });
      expect(parseKlineRows([goodRow, badRow])).toBeNull();
      expect(parseKlineRows([badRow, goodRow])).toBeNull();
    });

    test("returned rows are frozen, not mutable", () => {
      const result = parseKlineRows([realRow(1_700_000_000_000)]);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result[0])).toBe(true);
    });
  });
});

describe("live timestamp policy", () => {
  test("rejects a duration-correct closed kline whose event/open time is beyond the live future-skew bound", () => {
    const openTime = Math.floor((RECEIVED_AT_MS + 180_000) / 60_000) * 60_000;
    const result = normalize("SPOT", "KLINE", {
      ...REAL_SPOT_KLINE,
      E: openTime,
      k: { ...REAL_SPOT_KLINE.k, t: openTime, T: openTime + 59_999, x: true },
    }, "1m");
    expect(result.state).toBe("UNAVAILABLE");
    expect(result.reason).toBe("EVENT_TIME_TOO_FAR_IN_FUTURE");
  });
});

// L1L2-V2-012. The published v1 schema is what other ChartPrime devs will
// validate against, so a reason code the normalizer can emit but the schema
// omits makes a correctly-degraded envelope fail its own contract. That had
// already happened once (KLINE_VOLUME_RANGE_INVALID, emitted and tested here
// since P1.02, absent from both the schema and the markdown table). Deriving
// the emitted set from the source keeps the two in lockstep as reasons are
// added, instead of relying on someone remembering to update three files.
describe("degraded-reason vocabulary matches the published v1 contract", () => {
  const fs = require("node:fs");
  const path = require("node:path");

  const NORMALIZER_PATH = path.join(
    __dirname, "..", "..", "..", "src", "providers", "binance", "binance-event-normalizer.js",
  );
  const SCHEMA_PATH = path.join(
    __dirname, "..", "..", "..", "..", "..",
    "docs", "contracts", "binance-canonical-event", "v1", "binance-canonical-event-v1.schema.json",
  );

  function emittedReasons() {
    const source = fs.readFileSync(NORMALIZER_PATH, "utf8");
    const direct = [...source.matchAll(/degradedState\(\s*[^)]*?"([A-Z_]+)"/g)].map((m) => m[1]);
    // assessLiveEventTime's own reasons reach degradedState via a variable.
    const viaTimePolicy = ["EVENT_TIME_INVALID", "EVENT_TIME_TOO_FAR_IN_FUTURE"];
    return new Set([...direct, ...viaTimePolicy]);
  }

  function schemaReasons() {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
    return new Set(schema.$defs.degradedEnvelope.properties.reason.enum);
  }

  test("every reason the normalizer can emit is declared in the schema enum", () => {
    const undeclared = [...emittedReasons()].filter((reason) => !schemaReasons().has(reason)).sort();
    expect(undeclared).toEqual([]);
  });

  test("the schema declares no reason the normalizer cannot emit", () => {
    const unreachable = [...schemaReasons()].filter((reason) => !emittedReasons().has(reason)).sort();
    expect(unreachable).toEqual([]);
  });

  test("the source-derived reason set is non-trivial, so a regex that stops matching fails loudly", () => {
    expect(emittedReasons().size).toBeGreaterThanOrEqual(10);
    expect(emittedReasons()).toContain("KLINE_VOLUME_RANGE_INVALID");
  });
});
