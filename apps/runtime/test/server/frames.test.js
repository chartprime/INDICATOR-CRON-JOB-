const {
  INTERVAL_MS,
  BOOK_DEPTH_LEVELS,
  toWireSymbol,
  fromWireSymbol,
  tradeEnvelopeToFrame,
  klineEnvelopeToFrame,
  restKlineRowToBarFrame,
  storageCandleRowToBarFrame,
  storageTradeRowToTradeFrame,
  aggressiveHistoryFrame,
  MAX_AGGRESSIVE_HISTORY_TRADES,
  AGGRESSIVE_HISTORY_REASONS,
  markerFrame,
  bookFailureReason,
  profileFrame,
  vpinFrame,
  snapshotFrame,
  healthFrame,
  bookFrame,
  selectionFrame,
  dxfeedToWireSymbol,
  dxfeedFromWireSymbol,
  dxfeedTradeFrame,
  dxfeedMarkerFrame,
  dxfeedProfileFrame,
  dxfeedVpinFrame,
  dxfeedBarFrame,
  storageDxFeedCandleRowToBarFrame,
  dxfeedHealthFrame,
  dxfeedBookFrame,
  dxfeedSelectionFrame,
  dxfeedSnapshotFrame,
  MAX_WIRE_MAGNITUDE,
  markerHistoryFrame,
  markerHistoryFrames,
  MAX_MARKER_HISTORY_ROWS,
  MAX_SNAPSHOT_MARKERS,
  frameKindOf,
  FRAME_KIND_CONTROL,
  FRAME_KIND_LATEST_STATE,
  FRAME_KIND_INCREMENTAL,
  FRAME_KIND_BULK_HISTORY,
} = require("../../src/server/frames");
const {
  normalizeBinanceEvent,
  parseKlineRows,
} = require("../../src/providers/binance/binance-event-normalizer");

describe("equity trade-size domain", () => {
  test("retains the recorded 12.14-million-share NVDA print without widening prices or futures sizes", () => {
    const input = { symbol: "NVDA", assetClass: "EQUITY", tsExchange: 1790366400407, price: "225.07", size: "12140109", side: "buy", tradeId: "close-print" };
    const trade = dxfeedTradeFrame(input);
    const marker = dxfeedMarkerFrame(input);
    expect(trade.size).toBe(12140109);
    expect(marker.size).toBe(trade.size);
    expect(markerHistoryFrame({ provider: "DXFEED", symbol: "NVDA", assetClass: "EQUITY" }, { reset: true, seq: 0, markers: [marker] }).rows[0][2]).toBe(trade.size);
    for (const build of [dxfeedTradeFrame, dxfeedMarkerFrame]) {
      expect(() => build({ ...input, size: "1000000000001" })).toThrow(/size/);
      expect(() => build({ ...input, price: "10000001" })).toThrow(/price/);
      expect(() => build({ ...input, assetClass: "FUTURE", symbol: "/ESZ26:XCME" })).toThrow(/size/);
    }
  });
});
const {
  listAllowedCandleIntervals,
} = require("../../src/providers/binance/binance-config");
const {
  SINGLE_PRINT_RATIO,
  MAX_PROFILE_BUCKETS,
} = require("../../src/indicators/volume-profile/volume-profile-engine");

// Real captured payloads, same fixtures binance-event-normalizer.test.js
// uses -- run through the real normalizer so these tests exercise the
// actual envelope shape the server receives, not an invented one.
const REAL_SPOT_TRADE = {
  e: "trade",
  E: 1786444824142,
  s: "BTCUSDT",
  t: 6567786021,
  p: "64275.99000000",
  q: "0.00206000",
  T: 1786444824142,
  m: false,
  M: true,
};
const REAL_SPOT_KLINE = {
  e: "kline",
  E: 1786449754019,
  s: "BTCUSDT",
  k: {
    t: 1786449720000,
    T: 1786449779999,
    s: "BTCUSDT",
    i: "1m",
    f: 6567844718,
    L: 6567845845,
    o: "64419.99000000",
    c: "64435.29000000",
    h: "64436.00000000",
    l: "64419.99000000",
    v: "5.72330000",
    n: 1128,
    x: false,
    q: "368753.75046110",
    V: "4.74895000",
    Q: "305973.44158110",
    B: "0",
  },
};

function normalizeTrade(raw, marketKind = "SPOT") {
  return normalizeBinanceEvent(
    { marketKind, symbol: "BTCUSDT", eventType: "TRADE", raw },
    { receivedAtMs: 1786444824200 },
  );
}

function normalizeKline(raw, interval = "1m", marketKind = "SPOT") {
  return normalizeBinanceEvent(
    { marketKind, symbol: "BTCUSDT", eventType: "KLINE", interval, raw },
    { receivedAtMs: 1786449754100 },
  );
}

describe("server/frames", () => {
  describe("symbol mapping", () => {
    test("toWireSymbol inserts a hyphen before the USDT quote asset", () => {
      expect(toWireSymbol("BTCUSDT")).toBe("BTC-USDT");
      expect(toWireSymbol("ETHUSDT")).toBe("ETH-USDT");
    });

    test("fromWireSymbol strips the hyphen back out", () => {
      expect(fromWireSymbol("BTC-USDT")).toBe("BTCUSDT");
      expect(fromWireSymbol("ETH-USDT")).toBe("ETHUSDT");
    });

    test("round-trips both directions without loss", () => {
      for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
        expect(fromWireSymbol(toWireSymbol(symbol))).toBe(symbol);
      }
    });

    test("rejects a symbol shape it doesn't recognize rather than mangling it", () => {
      expect(() => toWireSymbol("BTCUSD")).toThrow(/unsupported symbol shape/);
      expect(() => toWireSymbol(undefined)).toThrow(/unsupported symbol shape/);
      expect(() => fromWireSymbol("BTCUSDT")).toThrow(
        /unsupported symbol shape/,
      );
      expect(() => toWireSymbol("SOLUSDT")).toThrow(/unsupported symbol shape/);
      expect(() => fromWireSymbol("SOL-USDT")).toThrow(
        /unsupported symbol shape/,
      );
    });
  });

  describe("INTERVAL_MS", () => {
    test("every allowed candle interval has a real ms entry", () => {
      for (const interval of listAllowedCandleIntervals()) {
        expect(Number.isInteger(INTERVAL_MS[interval])).toBe(true);
      }
    });

    test("1m is exactly 60 real seconds, not an approximation", () => {
      expect(INTERVAL_MS["1m"]).toBe(60_000);
    });
  });

  describe("tradeEnvelopeToFrame", () => {
    test("converts a real healthy TRADE envelope field-by-field", () => {
      const envelope = normalizeTrade(REAL_SPOT_TRADE);
      const frame = tradeEnvelopeToFrame(envelope);
      expect(frame).toEqual({
        type: "trade",
        provider: "BINANCE",
        symbol: "BTC-USDT",
        marketKind: "SPOT",
        ts_exchange: 1786444824142,
        price: 64275.99,
        size: 0.00206,
        side: "buy",
        trade_id: "6567786021",
      });
    });

    test("isBuyerMaker true maps to side sell, not buy -- verified against the Python reference's own convention", () => {
      const envelope = normalizeTrade({ ...REAL_SPOT_TRADE, m: true });
      expect(tradeEnvelopeToFrame(envelope).side).toBe("sell");
    });

    test("trade_id is always a string, even though the canonical payload keeps it numeric", () => {
      const envelope = normalizeTrade(REAL_SPOT_TRADE);
      expect(typeof envelope.payload.tradeId).toBe("number");
      expect(typeof tradeEnvelopeToFrame(envelope).trade_id).toBe("string");
    });

    test("marketKind carries through from the envelope, not hardcoded to SPOT", () => {
      const envelope = normalizeTrade(REAL_SPOT_TRADE, "PERPETUAL");
      expect(tradeEnvelopeToFrame(envelope).marketKind).toBe("PERPETUAL");
    });

    test("rejects exact decimals that overflow or underflow the numeric wire format", () => {
      const envelope = normalizeTrade(REAL_SPOT_TRADE);
      expect(() =>
        tradeEnvelopeToFrame({
          ...envelope,
          payload: { ...envelope.payload, price: "9".repeat(400) },
        }),
      ).toThrow(/wire-number range/);
      expect(() =>
        tradeEnvelopeToFrame({
          ...envelope,
          payload: { ...envelope.payload, quantity: `0.${"0".repeat(400)}1` },
        }),
      ).toThrow(/wire-number range/);
    });

    test("accepts only canonical decimal inputs, never JavaScript coercion shortcuts", () => {
      const envelope = normalizeTrade(REAL_SPOT_TRADE);
      for (const price of [true, "", " ", "0x10", "1e3", "+1", "1."]) {
        expect(() =>
          tradeEnvelopeToFrame({
            ...envelope,
            payload: { ...envelope.payload, price },
          }),
        ).toThrow(/wire-number range/);
      }
      expect(
        tradeEnvelopeToFrame({
          ...envelope,
          payload: { ...envelope.payload, price: "0001.2500" },
        }).price,
      ).toBe(1.25);
    });

    test("rejects control characters in externally sourced trade ids", () => {
      const envelope = normalizeTrade(REAL_SPOT_TRADE);
      expect(() =>
        tradeEnvelopeToFrame({
          ...envelope,
          payload: { ...envelope.payload, tradeId: "valid-looking\nforged" },
        }),
      ).toThrow(/trade id/);
    });

    test("uses the same finite magnitude ceiling enforced by the browser frame parser", () => {
      const envelope = normalizeTrade(REAL_SPOT_TRADE);
      expect(
        tradeEnvelopeToFrame({
          ...envelope,
          payload: { ...envelope.payload, price: String(MAX_WIRE_MAGNITUDE) },
        }).price,
      ).toBe(MAX_WIRE_MAGNITUDE);
      expect(() =>
        tradeEnvelopeToFrame({
          ...envelope,
          payload: {
            ...envelope.payload,
            price: String(MAX_WIRE_MAGNITUDE + 1),
          },
        }),
      ).toThrow(/wire-number range/);
    });
  });

  describe("klineEnvelopeToFrame", () => {
    test("converts a real still-forming KLINE envelope field-by-field", () => {
      const envelope = normalizeKline(REAL_SPOT_KLINE);
      const frame = klineEnvelopeToFrame(envelope);
      expect(frame).toEqual({
        type: "bar",
        provider: "BINANCE",
        symbol: "BTC-USDT",
        marketKind: "SPOT",
        interval_ms: 60_000,
        ts_open: 1786449720000,
        open: 64419.99,
        high: 64436,
        low: 64419.99,
        close: 64435.29,
        volume: 5.7233,
        buy_volume: 4.74895,
        trade_count: 1128,
        closed: false,
      });
    });

    test("isClosed true maps directly to closed true, no extra bucketing logic involved", () => {
      const envelope = normalizeKline({
        ...REAL_SPOT_KLINE,
        k: { ...REAL_SPOT_KLINE.k, x: true },
      });
      expect(klineEnvelopeToFrame(envelope).closed).toBe(true);
    });

    test("a 5m kline resolves interval_ms from the real subscribed interval, not a hardcoded 1m", () => {
      const openTime = Math.floor(REAL_SPOT_KLINE.k.t / 300_000) * 300_000;
      const fiveMinuteKline = {
        ...REAL_SPOT_KLINE,
        k: {
          ...REAL_SPOT_KLINE.k,
          i: "5m",
          t: openTime,
          T: openTime + 300_000 - 1,
        },
      };
      const envelope = normalizeKline(fiveMinuteKline, "5m");
      expect(klineEnvelopeToFrame(envelope).interval_ms).toBe(300_000);
    });

    test("marketKind carries through from the envelope, not hardcoded to SPOT", () => {
      const envelope = normalizeKline(REAL_SPOT_KLINE, "1m", "PERPETUAL");
      expect(klineEnvelopeToFrame(envelope).marketKind).toBe("PERPETUAL");
    });
  });

  describe("restKlineRowToBarFrame", () => {
    // Real REST /klines row shape, run through the real parseKlineRows
    // validator first -- same discipline as klineEnvelopeToFrame's own
    // tests running fixtures through the real normalizer.
    function realRow(openTime, closeTime) {
      return [
        openTime,
        "64200.00",
        "64300.50",
        "64150.25",
        "64275.99",
        "12.34500000",
        closeTime,
        "792345.11",
        418,
        "6.0",
        "385000.0",
        "0",
      ];
    }

    test("converts a real validated closed row field-by-field", () => {
      const [row] = parseKlineRows([
        realRow(1_740_000_000_000, 1_740_000_059_999),
      ]);
      const frame = restKlineRowToBarFrame(row, "BTCUSDT", "SPOT", "1m");
      expect(frame).toEqual({
        type: "bar",
        provider: "BINANCE",
        symbol: "BTC-USDT",
        marketKind: "SPOT",
        interval_ms: 60_000,
        ts_open: 1_740_000_000_000,
        open: 64200,
        high: 64300.5,
        low: 64150.25,
        close: 64275.99,
        volume: 12.345,
        buy_volume: 6,
        trade_count: 418,
        closed: true,
        reconstructed: true,
      });
    });

    test("resolves interval_ms from the requested interval, not a hardcoded 1m", () => {
      const [row] = parseKlineRows([
        realRow(1_740_000_000_000, 1_740_000_299_999),
      ]);
      expect(
        restKlineRowToBarFrame(row, "BTCUSDT", "SPOT", "5m").interval_ms,
      ).toBe(300_000);
    });

    test("marketKind carries through from the caller, not hardcoded to SPOT", () => {
      const [row] = parseKlineRows([
        realRow(1_740_000_000_000, 1_740_000_059_999),
      ]);
      expect(
        restKlineRowToBarFrame(row, "BTCUSDT", "PERPETUAL", "1m").marketKind,
      ).toBe("PERPETUAL");
    });

    test("throws on an unrecognized interval, same as klineEnvelopeToFrame", () => {
      const [row] = parseKlineRows([
        realRow(1_740_000_000_000, 1_740_000_059_999),
      ]);
      expect(() =>
        restKlineRowToBarFrame(row, "BTCUSDT", "SPOT", "3m"),
      ).toThrow(/unrecognized/);
    });

    test("returns null, not a frame claiming closed:true, for a row whose closeTime is still in the future", () => {
      const openTime = Math.floor(Date.now() / 60_000) * 60_000;
      const [row] = parseKlineRows([realRow(openTime, openTime + 59_999)]);
      expect(restKlineRowToBarFrame(row, "BTCUSDT", "SPOT", "1m")).toBeNull();
    });

    test("a row whose closeTime just passed is accepted as closed", () => {
      const closedBoundary = Math.floor(Date.now() / 60_000) * 60_000;
      const [row] = parseKlineRows([
        realRow(closedBoundary - 60_000, closedBoundary - 1),
      ]);
      expect(
        restKlineRowToBarFrame(row, "BTCUSDT", "SPOT", "1m"),
      ).not.toBeNull();
    });
  });

  describe("storageCandleRowToBarFrame", () => {
    function realRow() {
      return {
        ts_open: 1_740_000_000_000,
        open: "64200.00",
        high: "64300.50",
        low: "64150.25",
        close: "64275.99",
        volume: "12.34500000",
        trade_count: 418,
        taker_buy_base_volume: "6.0",
      };
    }

    test("converts a real stored row field-by-field, including buy_volume", () => {
      const frame = storageCandleRowToBarFrame(
        realRow(),
        "BTCUSDT",
        "SPOT",
        "1m",
      );
      expect(frame).toEqual({
        type: "bar",
        provider: "BINANCE",
        symbol: "BTC-USDT",
        marketKind: "SPOT",
        interval_ms: 60_000,
        ts_open: 1_740_000_000_000,
        open: 64200,
        high: 64300.5,
        low: 64150.25,
        close: 64275.99,
        volume: 12.345,
        buy_volume: 6,
        trade_count: 418,
        closed: true,
      });
    });

    test("omits buy_volume entirely for a pre-migration row where the column is NULL", () => {
      const row = { ...realRow(), taker_buy_base_volume: null };
      const frame = storageCandleRowToBarFrame(row, "BTCUSDT", "SPOT", "1m");
      expect(frame).not.toHaveProperty("buy_volume");
    });

    test("marketKind carries through from the caller, not hardcoded to SPOT", () => {
      expect(
        storageCandleRowToBarFrame(realRow(), "BTCUSDT", "PERPETUAL", "1m")
          .marketKind,
      ).toBe("PERPETUAL");
    });

    test("throws on an unrecognized interval, same as the other bar builders", () => {
      expect(() =>
        storageCandleRowToBarFrame(realRow(), "BTCUSDT", "SPOT", "3m"),
      ).toThrow(/unrecognized/);
    });

    test("rejects a corrupt stored candle before it can poison a whole snapshot", () => {
      expect(() =>
        storageCandleRowToBarFrame(
          { ...realRow(), ts_open: 1_740_000_000_001 },
          "BTCUSDT",
          "SPOT",
          "1m",
        ),
      ).toThrow(/align/);
      expect(() =>
        storageCandleRowToBarFrame(
          { ...realRow(), high: "64100" },
          "BTCUSDT",
          "SPOT",
          "1m",
        ),
      ).toThrow(/OHLC/);
      expect(() =>
        storageCandleRowToBarFrame(
          { ...realRow(), taker_buy_base_volume: "13" },
          "BTCUSDT",
          "SPOT",
          "1m",
        ),
      ).toThrow(/buy volume/);
      expect(() =>
        storageCandleRowToBarFrame(
          { ...realRow(), trade_count: -1 },
          "BTCUSDT",
          "SPOT",
          "1m",
        ),
      ).toThrow(/trade_count/);
    });
  });

  describe("storageTradeRowToTradeFrame", () => {
    const row = {
      ts: 1_740_000_000_000,
      price: "64200",
      size: "1",
      side: "buy",
      trade_id: "stored-1",
    };

    test("rejects corrupt stored trade identity and timestamps at the server boundary", () => {
      expect(() =>
        storageTradeRowToTradeFrame({ ...row, ts: -1 }, "BTCUSDT", "SPOT"),
      ).toThrow(/timestamp/);
      expect(() =>
        storageTradeRowToTradeFrame({ ...row, side: "BUY" }, "BTCUSDT", "SPOT"),
      ).toThrow(/side/);
      expect(() =>
        storageTradeRowToTradeFrame(
          { ...row, trade_id: null },
          "BTCUSDT",
          "SPOT",
        ),
      ).toThrow(/trade id/);
      expect(() =>
        storageTradeRowToTradeFrame(
          { ...row, trade_id: " x " },
          "BTCUSDT",
          "SPOT",
        ),
      ).toThrow(/trade id/);
    });
  });

  describe("markerFrame", () => {
    test("wraps a large-notional trade into the wire shape, symbol hyphenated", () => {
      const trade = {
        ts_exchange: 1786444824142,
        price: "64275.99",
        size: "5.2",
        side: "buy",
        trade_id: "m-1",
      };
      expect(markerFrame(trade, "BTCUSDT", "SPOT")).toEqual({
        type: "marker",
        provider: "BINANCE",
        symbol: "BTC-USDT",
        marketKind: "SPOT",
        ts_exchange: 1786444824142,
        price: 64275.99,
        size: 5.2,
        side: "buy",
        trade_id: "m-1",
      });
    });

    test("rejects a non-finite price the same way trade/bar conversion does", () => {
      const trade = {
        ts_exchange: 1,
        price: NaN,
        size: 1,
        side: "buy",
        trade_id: "m-2",
      };
      expect(() => markerFrame(trade, "BTCUSDT", "SPOT")).toThrow(
        /wire-number range/,
      );
    });

    test("omits the baseline fields entirely rather than sending nulls, when no snapshot is supplied", () => {
      const trade = {
        ts_exchange: 1,
        price: 100,
        size: 1,
        side: "buy",
        trade_id: "m-5",
      };
      const frame = markerFrame(trade, "BTCUSDT", "SPOT");
      expect(Object.hasOwn(frame, "baseline_log_median")).toBe(false);
      expect(Object.hasOwn(frame, "baseline_log_mad")).toBe(false);
    });

    test("omits the baseline fields when the snapshot is still in its cold-start (null) state", () => {
      const trade = {
        ts_exchange: 1,
        price: 100,
        size: 1,
        side: "buy",
        trade_id: "m-6",
      };
      const frame = markerFrame(trade, "BTCUSDT", "SPOT", {
        logMedian: null,
        logMad: null,
        sampleCount: 0,
      });
      expect(Object.hasOwn(frame, "baseline_log_median")).toBe(false);
    });
  });

  // A2.20 / L1L2-V2-049. A crossed book was reported to the operator as
  // WIRE_VALUE_OUT_OF_RANGE -- a numeric-representation failure. The values are
  // perfectly in range; the ladder is crossed, which is real market data and
  // exactly what Phase 5's float-dust S1 produced. An operator would go hunting
  // an overflow that does not exist while the actual condition stayed invisible
  // (Pattern K). CROSSED_BOOK is already a published reason code in
  // dxfeed-order-book-v1, so naming it correctly is not a contract change.
  describe("book failure classification", () => {
    function crossedState() {
      return {
        status: "READY",
        book: {
          lastUpdateId: 1,
          bids: [["101", "1"]],
          asks: [["100", "1"]],
        },
      };
    }

    function misorderedState() {
      return {
        status: "READY",
        book: {
          lastUpdateId: 1,
          bids: [
            ["98", "1"],
            ["99", "1"],
          ],
          asks: [["100", "1"]],
        },
      };
    }

    test("a crossed book throws an error carrying the CROSSED_BOOK code", () => {
      expect(() => bookFrame("BTCUSDT", "SPOT", crossedState())).toThrow(
        /crossed/,
      );
      try {
        bookFrame("BTCUSDT", "SPOT", crossedState());
      } catch (error) {
        expect(error.code).toBe("CROSSED_BOOK");
      }
    });

    test("misordered levels are classified the same way -- both are ladder faults, not range faults", () => {
      try {
        bookFrame("BTCUSDT", "SPOT", misorderedState());
      } catch (error) {
        expect(error.code).toBe("CROSSED_BOOK");
      }
    });

    test("bookFailureReason names a crossed ladder rather than a numeric range", () => {
      try {
        bookFrame("BTCUSDT", "SPOT", crossedState());
      } catch (error) {
        expect(bookFailureReason(error)).toBe("CROSSED_BOOK");
      }
    });

    // A genuine wire-range failure must still report as one -- the point is to
    // tell the two apart, not to relabel everything as crossed.
    test("a genuine unrepresentable value still reports WIRE_VALUE_OUT_OF_RANGE", () => {
      const oversized = {
        status: "READY",
        book: { lastUpdateId: 1, bids: [["100000000000000", "1"]], asks: [] },
      };
      try {
        bookFrame("BTCUSDT", "SPOT", oversized);
        throw new Error(
          "expected bookFrame to reject an unrepresentable price",
        );
      } catch (error) {
        expect(bookFailureReason(error)).toBe("WIRE_VALUE_OUT_OF_RANGE");
      }
    });

    test("an error from anywhere else is not silently called a crossed book", () => {
      expect(bookFailureReason(new Error("something else entirely"))).toBe(
        "WIRE_VALUE_OUT_OF_RANGE",
      );
      expect(bookFailureReason(undefined)).toBe("WIRE_VALUE_OUT_OF_RANGE");
    });
  });

  describe("profileFrame", () => {
    function engineState({
      mode = "continuous",
      periodStartTs = 1000,
      periodEndTs = null,
      originPrice = 100,
      rowWidth = 1,
      buckets,
    }) {
      const bucketMap = new Map(buckets);
      let maxVolume = -Infinity;
      let pocIndex = null;
      for (const [index, bucket] of bucketMap) {
        if (bucket.volume > maxVolume) {
          maxVolume = bucket.volume;
          pocIndex = index;
        }
      }
      const singlePrintBuckets = [...bucketMap.entries()]
        .filter(([, bucket]) => bucket.volume < maxVolume * SINGLE_PRINT_RATIO)
        .map(([index]) => index);
      return {
        session: {
          periodStartTs,
          periodEndTs,
          rowWidth,
          originPrice,
          buckets: bucketMap,
        },
        profile: {
          pocIndex,
          vaHigh: pocIndex,
          vaLow: pocIndex,
          totalVolume: maxVolume,
          singlePrintBuckets,
        },
        mode,
      };
    }

    // A2.20 / L1L2-V2-061. The browser's parseProfileFrame rejects the whole
    // frame unless poc_price, vah_price and val_price are each `===` some
    // bucket's price -- and a rejected frame is the failCurrentSocket
    // reconnect loop, not a degraded profile. That guarantee used to hold only
    // because the same arithmetic expression was written twice on this side:
    // buckets as originPrice + bucketIndex * rowWidth, and the three summary
    // prices as originPrice + pocIndex * rowWidth. Bit-identical by
    // coincidence, not by construction (Pattern R). The three prices are now
    // read out of the bucket list that was actually emitted, so the client's
    // equality check cannot be broken by a future rounding or tick-snapping
    // change that touches one computation and not the other.
    test.each([
      ["whole numbers", 100, 1],
      ["a fractional row width that is not representable in binary", 0.1, 0.1],
      ["a tick size that compounds error across many buckets", 1837.35, 0.05],
      ["an equity tick against a large origin", 68421.07, 0.01],
    ])(
      "summary prices are drawn from the emitted buckets, not recomputed -- %s",
      (_label, originPrice, rowWidth) => {
        const state = engineState({
          originPrice,
          rowWidth,
          buckets: [
            [0, { volume: 3, buyVolume: 2, sellVolume: 1 }],
            [7, { volume: 9, buyVolume: 5, sellVolume: 4 }],
            [13, { volume: 4, buyVolume: 1, sellVolume: 3 }],
          ],
        });
        state.profile.vaLow = 0;
        state.profile.vaHigh = 13;

        const frame = profileFrame(state, "BTCUSDT", "SPOT");
        const bucketPrices = frame.buckets.map((bucket) => bucket.price);

        expect(bucketPrices).toContain(frame.poc_price);
        expect(bucketPrices).toContain(frame.vah_price);
        expect(bucketPrices).toContain(frame.val_price);
        expect(frame.poc_price).toBe(bucketPrices[1]);
        expect(frame.val_price).toBe(bucketPrices[0]);
        expect(frame.vah_price).toBe(bucketPrices[2]);
      },
    );

    test("wraps a running profile into the wire shape, buckets ascending by price", () => {
      const state = engineState({
        buckets: [
          [1, { volume: 2, buyVolume: 2, sellVolume: 0 }],
          [0, { volume: 5, buyVolume: 3, sellVolume: 2 }],
        ],
      });
      expect(profileFrame(state, "BTCUSDT", "SPOT")).toEqual({
        type: "profile",
        provider: "BINANCE",
        symbol: "BTC-USDT",
        marketKind: "SPOT",
        mode: "continuous",
        delivery_scope: "LIVE",
        history_request_id: null,
        period_start_ts: 1000,
        period_end_ts: null,
        row_width: 1,
        buckets: [
          {
            price: 100,
            volume: 5,
            buy_volume: 3,
            sell_volume: 2,
            single_print: false,
          },
          {
            price: 101,
            volume: 2,
            buy_volume: 2,
            sell_volume: 0,
            single_print: false,
          },
        ],
        poc_price: 100,
        vah_price: 100,
        val_price: 100,
      });
    });

    test("a closed period carries a non-null period_end_ts", () => {
      const state = engineState({
        periodEndTs: 2000,
        buckets: [[0, { volume: 1, buyVolume: 1, sellVolume: 0 }]],
      });
      expect(profileFrame(state, "BTCUSDT", "SPOT").period_end_ts).toBe(2000);
    });

    test("marks a bucket well below the POC's volume as single_print, and the POC itself as not", () => {
      const state = engineState({
        buckets: [
          [0, { volume: 100, buyVolume: 100, sellVolume: 0 }],
          [1, { volume: 5, buyVolume: 0, sellVolume: 5 }],
        ],
      });
      const frame = profileFrame(state, "BTCUSDT", "SPOT");
      expect(frame.buckets.find((b) => b.price === 100).single_print).toBe(
        false,
      );
      expect(frame.buckets.find((b) => b.price === 101).single_print).toBe(
        true,
      );
    });

    test("rejects an invalid mode", () => {
      const state = engineState({
        mode: "bogus",
        buckets: [[0, { volume: 1, buyVolume: 1, sellVolume: 0 }]],
      });
      expect(() => profileFrame(state, "BTCUSDT", "SPOT")).toThrow(/mode/);
    });

    test("rejects an empty profile -- the caller must not send a frame until there is real data", () => {
      const state = engineState({ buckets: [] });
      expect(() => profileFrame(state, "BTCUSDT", "SPOT")).toThrow(
        /at least one bucket/,
      );
    });

    test("rejects periodEndTs preceding periodStartTs", () => {
      const state = engineState({
        periodStartTs: 2000,
        periodEndTs: 1000,
        buckets: [[0, { volume: 1, buyVolume: 1, sellVolume: 0 }]],
      });
      expect(() => profileFrame(state, "BTCUSDT", "SPOT")).toThrow(
        /periodEndTs/,
      );
    });

    test("rejects a non-finite bucket volume the same way trade/bar conversion does", () => {
      const state = engineState({
        buckets: [[0, { volume: NaN, buyVolume: 0, sellVolume: 0 }]],
      });
      state.profile.pocIndex = 0;
      state.profile.vaHigh = 0;
      state.profile.vaLow = 0;
      expect(() => profileFrame(state, "BTCUSDT", "SPOT")).toThrow(
        /wire-number range/,
      );
    });

    test("rejects more buckets than the wire cap allows", () => {
      // One past the cap, referenced from the engine so raising the ceiling
      // cannot silently stop exercising this guard.
      const buckets = Array.from(
        { length: MAX_PROFILE_BUCKETS + 1 },
        (_, i) => [i, { volume: 1, buyVolume: 1, sellVolume: 0 }],
      );
      const state = engineState({ buckets });
      expect(() => profileFrame(state, "BTCUSDT", "SPOT")).toThrow(
        /must not exceed/,
      );
    });

    test("rejects a POC/Value Area index that does not reference an existing bucket", () => {
      const state = engineState({
        buckets: [[0, { volume: 1, buyVolume: 1, sellVolume: 0 }]],
      });
      state.profile.vaHigh = 5;
      expect(() => profileFrame(state, "BTCUSDT", "SPOT")).toThrow(
        /existing buckets/,
      );
    });

    test("rejects a Value Area that does not nest around the POC", () => {
      const state = engineState({
        buckets: [
          [0, { volume: 1, buyVolume: 1, sellVolume: 0 }],
          [1, { volume: 5, buyVolume: 5, sellVolume: 0 }],
          [2, { volume: 1, buyVolume: 1, sellVolume: 0 }],
        ],
      });
      state.profile.pocIndex = 0;
      state.profile.vaHigh = 1;
      state.profile.vaLow = 1;
      expect(() => profileFrame(state, "BTCUSDT", "SPOT")).toThrow(
        /nest around the POC/,
      );
    });
  });

  describe("vpinFrame", () => {
    function reading(overrides = {}) {
      return {
        sealTs: 1_000,
        active: false,
        direction: null,
        strength: 0,
        zVpin: null,
        zVelocity: null,
        zAcceleration: null,
        activatedAtTs: null,
        ...overrides,
      };
    }

    test("wraps an inactive reading into the wire shape", () => {
      expect(vpinFrame(reading(), "BTCUSDT", "SPOT")).toEqual({
        type: "vpin",
        provider: "BINANCE",
        symbol: "BTC-USDT",
        marketKind: "SPOT",
        seal_ts: 1_000,
        active: false,
        direction: null,
        strength: 0,
        z_vpin: null,
        z_velocity: null,
        z_acceleration: null,
        activated_at_ts: null,
      });
    });

    test("wraps an active reading, direction/strength/activatedAtTs all carried through", () => {
      const state = reading({
        active: true,
        direction: "buy",
        strength: 0.75,
        zVpin: 1.4,
        zVelocity: 0.2,
        zAcceleration: 0.05,
        activatedAtTs: 800,
      });
      const frame = vpinFrame(state, "BTCUSDT", "SPOT");
      expect(frame.active).toBe(true);
      expect(frame.direction).toBe("buy");
      expect(frame.strength).toBe(0.75);
      expect(frame.z_vpin).toBe(1.4);
      expect(frame.activated_at_ts).toBe(800);
    });

    test("rejects an active reading with no direction, and an inactive reading carrying one", () => {
      expect(() =>
        vpinFrame(
          reading({
            active: true,
            direction: null,
            strength: 0.5,
            activatedAtTs: 900,
          }),
          "BTCUSDT",
          "SPOT",
        ),
      ).toThrow(/must carry a direction/);
      expect(() =>
        vpinFrame(reading({ direction: "buy" }), "BTCUSDT", "SPOT"),
      ).toThrow(/cannot carry a direction/);
    });

    test("rejects strength outside [0, 1], or inconsistent with active", () => {
      expect(() =>
        vpinFrame(reading({ strength: 1.5 }), "BTCUSDT", "SPOT"),
      ).toThrow(/strength/);
      expect(() =>
        vpinFrame(reading({ strength: -0.1 }), "BTCUSDT", "SPOT"),
      ).toThrow(/strength/);
      expect(() =>
        vpinFrame(
          reading({
            active: true,
            direction: "buy",
            strength: 0,
            activatedAtTs: 900,
          }),
          "BTCUSDT",
          "SPOT",
        ),
      ).toThrow(/positive strength/);
      expect(() =>
        vpinFrame(reading({ strength: 0.1 }), "BTCUSDT", "SPOT"),
      ).toThrow(/zero strength/);
    });

    test("rejects a non-finite zVpin/zVelocity/zAcceleration when not null", () => {
      expect(() =>
        vpinFrame(reading({ zVpin: NaN }), "BTCUSDT", "SPOT"),
      ).toThrow(/zVpin/);
      expect(() =>
        vpinFrame(reading({ zVelocity: Infinity }), "BTCUSDT", "SPOT"),
      ).toThrow(/zVelocity/);
    });

    test("accepts null zVpin/zVelocity/zAcceleration -- the pre-baseline-warmup case", () => {
      expect(() => vpinFrame(reading(), "BTCUSDT", "SPOT")).not.toThrow();
    });

    test("rejects activatedAtTs after sealTs, and activatedAtTs inconsistent with active", () => {
      expect(() =>
        vpinFrame(
          reading({
            active: true,
            direction: "buy",
            strength: 0.5,
            activatedAtTs: 1_001,
          }),
          "BTCUSDT",
          "SPOT",
        ),
      ).toThrow(/activatedAtTs/);
      expect(() =>
        vpinFrame(
          reading({
            active: true,
            direction: "buy",
            strength: 0.5,
            activatedAtTs: null,
          }),
          "BTCUSDT",
          "SPOT",
        ),
      ).toThrow(/must carry activatedAtTs/);
      expect(() =>
        vpinFrame(reading({ activatedAtTs: 500 }), "BTCUSDT", "SPOT"),
      ).toThrow(/cannot carry activatedAtTs/);
    });

    test("activatedAtTs equal to sealTs is valid -- the exact bucket that just activated", () => {
      expect(() =>
        vpinFrame(
          reading({
            active: true,
            direction: "sell",
            strength: 0.3,
            activatedAtTs: 1_000,
          }),
          "BTCUSDT",
          "SPOT",
        ),
      ).not.toThrow();
    });
  });

  describe("snapshotFrame", () => {
    test("wraps closed bars, trades, and markers into the wire shape", () => {
      const bar = klineEnvelopeToFrame(
        normalizeKline({
          ...REAL_SPOT_KLINE,
          k: { ...REAL_SPOT_KLINE.k, x: true },
        }),
      );
      const trade = tradeEnvelopeToFrame(normalizeTrade(REAL_SPOT_TRADE));
      const marker = markerFrame(
        { ts_exchange: 1, price: 100, size: 1, side: "sell", trade_id: "m-3" },
        "BTCUSDT",
        "SPOT",
      );
      expect(
        snapshotFrame([bar], [trade], "BTCUSDT", "SPOT", [marker]),
      ).toEqual({
        type: "snapshot",
        provider: "BINANCE",
        symbol: "BTC-USDT",
        marketKind: "SPOT",
        bars: [bar],
        trades: [trade],
        markers: [marker],
      });
    });

    test("markers default to an empty array when the caller omits them entirely -- existing call sites still work", () => {
      const bar = klineEnvelopeToFrame(
        normalizeKline({
          ...REAL_SPOT_KLINE,
          k: { ...REAL_SPOT_KLINE.k, x: true },
        }),
      );
      expect(snapshotFrame([bar], [], "BTCUSDT", "SPOT").markers).toEqual([]);
    });

    test("an empty snapshot is valid -- the honest fresh-server-start state this project deliberately ships with no storage yet", () => {
      expect(snapshotFrame([], [], "BTCUSDT", "SPOT")).toEqual({
        type: "snapshot",
        provider: "BINANCE",
        symbol: "BTC-USDT",
        marketKind: "SPOT",
        bars: [],
        trades: [],
        markers: [],
      });
    });

    test("rejects a still-forming bar inside a snapshot -- every bar here must already be closed", () => {
      const stillForming = klineEnvelopeToFrame(
        normalizeKline(REAL_SPOT_KLINE),
      );
      expect(() =>
        snapshotFrame([stillForming], [], "BTCUSDT", "SPOT"),
      ).toThrow(/must already be closed/);
    });

    test("rejects non-array and over-cap snapshot collections before constructing an invalid wire frame", () => {
      const trade = tradeEnvelopeToFrame(normalizeTrade(REAL_SPOT_TRADE));
      expect(() => snapshotFrame(null, [], "BTCUSDT", "SPOT")).toThrow(
        /bars must be an array/,
      );
      expect(() =>
        snapshotFrame([], Array(101).fill(trade), "BTCUSDT", "SPOT"),
      ).toThrow(/at most 100/);
    });

    test("carries the pair's pool of big prints when supplied, pair-matched, unique and in time order", () => {
      const trade = tradeEnvelopeToFrame(normalizeTrade(REAL_SPOT_TRADE));
      const later = {
        ...trade,
        trade_id: "later",
        ts_exchange: trade.ts_exchange + 1,
      };
      const frame = snapshotFrame(
        [],
        [],
        "BTCUSDT",
        "SPOT",
        [],
        undefined,
        undefined,
        {
          prints: [trade, later],
          floor: 2.5,
          from: trade.ts_exchange - 60_000,
        },
      );
      expect(frame.aggressive_prints).toEqual([trade, later]);
      expect(frame.aggressive_prints_floor).toBe(2.5);
      expect(frame.aggressive_prints_from).toBe(trade.ts_exchange - 60_000);
      expect(
        Object.hasOwn(
          snapshotFrame([], [], "BTCUSDT", "SPOT"),
          "aggressive_prints",
        ),
      ).toBe(false);
      const bad = (pool) => () =>
        snapshotFrame(
          [],
          [],
          "BTCUSDT",
          "SPOT",
          [],
          undefined,
          undefined,
          pool,
        );
      expect(bad({ prints: [later, trade], floor: 0, from: 0 })).toThrow(
        /time order/,
      );
      expect(bad({ prints: [trade, trade], floor: 0, from: 0 })).toThrow(
        /unique/,
      );
      expect(
        bad({
          prints: [{ ...trade, marketKind: "PERPETUAL" }],
          floor: 0,
          from: 0,
        }),
      ).toThrow(/pair-matched/);
      expect(
        bad({ prints: Array(20_001).fill(trade), floor: 0, from: 0 }),
      ).toThrow(/at most 20000/);
      expect(bad({ prints: [trade], floor: -1, from: 0 })).toThrow(/floor/);
      expect(bad({ prints: [trade], floor: 0, from: -1 })).toThrow(/from/);
    });

    test("omits vpin_readings entirely when the caller doesn't pass it -- existing call sites unaffected", () => {
      expect(
        Object.hasOwn(
          snapshotFrame([], [], "BTCUSDT", "SPOT"),
          "vpin_readings",
        ),
      ).toBe(false);
    });

    test("carries only a recognized VPIN lifecycle status when supplied", () => {
      expect(
        snapshotFrame([], [], "BTCUSDT", "SPOT", [], undefined, "WARMING")
          .vpin_status,
      ).toBe("WARMING");
      expect(
        snapshotFrame([], [], "BTCUSDT", "SPOT", [], undefined, "DISABLED")
          .vpin_status,
      ).toBe("DISABLED");
      expect(() =>
        snapshotFrame([], [], "BTCUSDT", "SPOT", [], undefined, "UNKNOWN"),
      ).toThrow(/vpin status is invalid/);
    });

    test("carries a chronological backfilled vpin_readings array when supplied", () => {
      const readings = [
        {
          sealTs: 100,
          active: false,
          direction: null,
          strength: 0,
          zVpin: null,
          zVelocity: null,
          zAcceleration: null,
          activatedAtTs: null,
        },
        {
          sealTs: 200,
          active: true,
          direction: "buy",
          strength: 0.4,
          zVpin: 1.1,
          zVelocity: null,
          zAcceleration: null,
          activatedAtTs: 200,
        },
      ];
      const frame = snapshotFrame([], [], "BTCUSDT", "SPOT", [], readings);
      expect(frame.vpin_readings).toEqual([
        {
          seal_ts: 100,
          active: false,
          direction: null,
          strength: 0,
          z_vpin: null,
          z_velocity: null,
          z_acceleration: null,
          activated_at_ts: null,
        },
        {
          seal_ts: 200,
          active: true,
          direction: "buy",
          strength: 0.4,
          z_vpin: 1.1,
          z_velocity: null,
          z_acceleration: null,
          activated_at_ts: 200,
        },
      ]);
    });

    test("rejects vpin_readings that go backward in time", () => {
      const readings = [
        {
          sealTs: 200,
          active: false,
          direction: null,
          strength: 0,
          zVpin: null,
          zVelocity: null,
          zAcceleration: null,
          activatedAtTs: null,
        },
        {
          sealTs: 100,
          active: false,
          direction: null,
          strength: 0,
          zVpin: null,
          zVelocity: null,
          zAcceleration: null,
          activatedAtTs: null,
        },
      ];
      expect(() =>
        snapshotFrame([], [], "BTCUSDT", "SPOT", [], readings),
      ).toThrow(/chronological/);
    });

    test("accepts two readings sharing the same seal_ts -- two buckets can legitimately seal within the same millisecond during a burst", () => {
      const readings = [
        {
          sealTs: 100,
          active: false,
          direction: null,
          strength: 0,
          zVpin: null,
          zVelocity: null,
          zAcceleration: null,
          activatedAtTs: null,
        },
        {
          sealTs: 100,
          active: true,
          direction: "buy",
          strength: 0.5,
          zVpin: 1.2,
          zVelocity: null,
          zAcceleration: null,
          activatedAtTs: 100,
        },
      ];
      expect(() =>
        snapshotFrame([], [], "BTCUSDT", "SPOT", [], readings),
      ).not.toThrow();
    });
  });

  describe("healthFrame", () => {
    test("builds a health frame from a real getFeedHealth-shaped context", () => {
      expect(
        healthFrame("BTCUSDT", "SPOT", {
          stale: false,
          recoveryState: "READY",
        }),
      ).toEqual({
        type: "health",
        provider: "BINANCE",
        symbol: "BTC-USDT",
        marketKind: "SPOT",
        recoveryState: "READY",
        stale: false,
      });
    });

    test("carries an optional reason without requiring one", () => {
      const withReason = healthFrame(
        "BTCUSDT",
        "SPOT",
        { stale: true, recoveryState: "UNAVAILABLE" },
        "CONNECTION_DOWN",
      );
      expect(withReason.reason).toBe("CONNECTION_DOWN");
      const withoutReason = healthFrame("BTCUSDT", "SPOT", {
        stale: true,
        recoveryState: "RECOVERING",
      });
      expect(withoutReason).not.toHaveProperty("reason");
    });

    test("marketKind is carried through as given, not hardcoded to SPOT", () => {
      expect(
        healthFrame("BTCUSDT", "PERPETUAL", {
          stale: false,
          recoveryState: "READY",
        }).marketKind,
      ).toBe("PERPETUAL");
    });

    test("carries the collector's recording state beside the feed's, and refuses a timestamp without the flag it explains", () => {
      // 2026-09-15: the collector died at 05:27 and the chart said LIVE all day; the feed was fine, the recording was not.
      const fresh = healthFrame("BTCUSDT", "SPOT", {
        stale: false,
        recoveryState: "READY",
        recordingStale: false,
        recordingLatestTs: 1_700_000_000_000,
      });
      expect(fresh).toMatchObject({
        recoveryState: "READY",
        stale: false,
        recordingStale: false,
        recordingLatestTs: 1_700_000_000_000,
      });
      // A recording that cannot be read has a flag and no timestamp.
      const unknown = healthFrame("BTCUSDT", "SPOT", {
        stale: false,
        recoveryState: "READY",
        recordingStale: true,
      });
      expect(unknown.recordingStale).toBe(true);
      expect(unknown).not.toHaveProperty("recordingLatestTs");
      // Neither field is invented when the server has nothing to say.
      const plain = healthFrame("BTCUSDT", "SPOT", {
        stale: false,
        recoveryState: "READY",
      });
      expect(plain).not.toHaveProperty("recordingStale");
      expect(plain).not.toHaveProperty("recordingLatestTs");
      expect(() =>
        healthFrame("BTCUSDT", "SPOT", {
          stale: false,
          recoveryState: "READY",
          recordingStale: "yes",
        }),
      ).toThrow(/recordingStale must be a boolean/);
      expect(() =>
        healthFrame("BTCUSDT", "SPOT", {
          stale: false,
          recoveryState: "READY",
          recordingStale: true,
          recordingLatestTs: -1,
        }),
      ).toThrow(/recordingLatestTs must be a non-negative safe integer/);
      expect(() =>
        healthFrame("BTCUSDT", "SPOT", {
          stale: false,
          recoveryState: "READY",
          recordingStale: true,
          recordingLatestTs: 1.5,
        }),
      ).toThrow(/recordingLatestTs must be a non-negative safe integer/);
      expect(() =>
        healthFrame("BTCUSDT", "SPOT", {
          stale: false,
          recoveryState: "READY",
          recordingLatestTs: 5,
        }),
      ).toThrow(/needs recordingStale beside it/);
    });
  });

  describe("bookFrame", () => {
    test("converts a real READY getOrderBook() state field-by-field", () => {
      const orderBookState = {
        status: "READY",
        book: {
          bids: [
            ["64275.99", "1.5"],
            ["64275.98", "2.0"],
          ],
          asks: [
            ["64276.00", "0.5"],
            ["64276.01", "3.0"],
          ],
          lastUpdateId: 98429383442,
        },
      };
      expect(bookFrame("BTCUSDT", "SPOT", orderBookState)).toEqual({
        type: "book",
        provider: "BINANCE",
        symbol: "BTC-USDT",
        marketKind: "SPOT",
        status: "READY",
        bids: [
          { price: 64275.99, size: 1.5 },
          { price: 64275.98, size: 2.0 },
        ],
        asks: [
          { price: 64276.0, size: 0.5 },
          { price: 64276.01, size: 3.0 },
        ],
        lastUpdateId: 98429383442,
        stale: false,
      });
    });

    test("truncates to the top N levels per side, not the full book", () => {
      const bids = Array.from({ length: BOOK_DEPTH_LEVELS + 10 }, (_, i) => [
        String(64000 - i),
        "1",
      ]);
      const asks = Array.from({ length: BOOK_DEPTH_LEVELS + 10 }, (_, i) => [
        String(64001 + i),
        "1",
      ]);
      const orderBookState = {
        status: "READY",
        book: { bids, asks, lastUpdateId: 1 },
      };
      const frame = bookFrame("BTCUSDT", "SPOT", orderBookState);
      expect(frame.bids).toHaveLength(BOOK_DEPTH_LEVELS);
      expect(frame.asks).toHaveLength(BOOK_DEPTH_LEVELS);
      expect(frame.bids[0]).toEqual({ price: 64000, size: 1 });
    });

    test("an explicit levels argument overrides the default depth", () => {
      const orderBookState = {
        status: "READY",
        book: {
          bids: [
            ["3", "1"],
            ["2", "1"],
            ["1", "1"],
          ],
          asks: [],
          lastUpdateId: 1,
        },
      };
      expect(bookFrame("BTCUSDT", "SPOT", orderBookState, 2).bids).toHaveLength(
        2,
      );
    });

    test("rejects book data that the browser would reject as unordered, crossed, or unsafe", () => {
      expect(() =>
        bookFrame("BTCUSDT", "SPOT", {
          status: "READY",
          book: {
            bids: [
              ["1", "1"],
              ["2", "1"],
            ],
            asks: [],
            lastUpdateId: 1,
          },
        }),
      ).toThrow(/strictly ordered/);
      expect(() =>
        bookFrame("BTCUSDT", "SPOT", {
          status: "READY",
          book: { bids: [["2", "1"]], asks: [["1", "1"]], lastUpdateId: 1 },
        }),
      ).toThrow(/crossed/);
      expect(() =>
        bookFrame("BTCUSDT", "SPOT", {
          status: "READY",
          book: {
            bids: [],
            asks: [],
            lastUpdateId: Number.MAX_SAFE_INTEGER + 1,
          },
        }),
      ).toThrow(/lastUpdateId/);
    });

    test("READY frames carry stale so a silent DEPTH feed is not painted as a live ladder", () => {
      const orderBookState = {
        status: "READY",
        book: { bids: [], asks: [], lastUpdateId: 1 },
      };
      expect(
        bookFrame("BTCUSDT", "SPOT", orderBookState, BOOK_DEPTH_LEVELS, {
          stale: true,
        }).stale,
      ).toBe(true);
    });

    test("rejects a negative levels argument rather than slicing from the end of the book", () => {
      const orderBookState = {
        status: "READY",
        book: { bids: [["1", "1"]], asks: [], lastUpdateId: 1 },
      };
      expect(() => bookFrame("BTCUSDT", "SPOT", orderBookState, -1)).toThrow(
        /non-negative integer/,
      );
      expect(() =>
        bookFrame("BTCUSDT", "SPOT", orderBookState, BOOK_DEPTH_LEVELS + 1),
      ).toThrow(/no greater than/);
    });

    test("rejects UNAVAILABLE without a reason -- emitting reason:undefined would be dropped by the worker and freeze the last ladder", () => {
      expect(() =>
        bookFrame("BTCUSDT", "SPOT", { status: "UNAVAILABLE" }),
      ).toThrow(/reason/);
    });

    test("rejects a status that is neither READY nor UNAVAILABLE rather than mapping it to an empty-reason UNAVAILABLE", () => {
      expect(() =>
        bookFrame("BTCUSDT", "SPOT", { status: "BUFFERING" }),
      ).toThrow(/READY or UNAVAILABLE/);
    });

    test("marketKind is carried through as given, not hardcoded to SPOT", () => {
      const orderBookState = {
        status: "READY",
        book: { bids: [], asks: [], lastUpdateId: 1 },
      };
      expect(bookFrame("BTCUSDT", "PERPETUAL", orderBookState).marketKind).toBe(
        "PERPETUAL",
      );
    });

    test.each([
      "CONNECTION_DOWN",
      "RECOVERY_IN_PROGRESS",
      "BUFFERING",
      "SNAPSHOT_MALFORMED",
      "SNAPSHOT_TOO_OLD",
      "SEQUENCE_GAP",
      "UPSTREAM_EVENT_UNAVAILABLE",
      "BUFFER_OVERFLOW_BEFORE_SNAPSHOT",
      "CROSSED_BOOK",
      "BOOK_LEVEL_CAP_EXCEEDED",
    ])(
      "represents the real getOrderBook() UNAVAILABLE reason %s honestly, no bids/asks fields at all",
      (reason) => {
        const frame = bookFrame("BTCUSDT", "SPOT", {
          status: "UNAVAILABLE",
          reason,
        });
        expect(frame).toEqual({
          type: "book",
          provider: "BINANCE",
          symbol: "BTC-USDT",
          marketKind: "SPOT",
          status: "UNAVAILABLE",
          reason,
        });
        expect(frame).not.toHaveProperty("bids");
        expect(frame).not.toHaveProperty("asks");
        expect(frame).not.toHaveProperty("lastUpdateId");
      },
    );
  });

  describe("selectionFrame", () => {
    test("builds the wire shape announcing the currently active pair", () => {
      expect(selectionFrame("ETHUSDT", "PERPETUAL")).toEqual({
        type: "selection",
        provider: "BINANCE",
        symbol: "ETH-USDT",
        marketKind: "PERPETUAL",
      });
    });

    test("rejects a symbol shape it doesn't recognize, same discipline as every other frame builder", () => {
      expect(() => selectionFrame("ETHUSD", "PERPETUAL")).toThrow(
        /unsupported symbol shape/,
      );
    });
  });

  describe("dxFeed symbol mapping", () => {
    test("dxfeedToWireSymbol/dxfeedFromWireSymbol pass real proven symbols through unchanged", () => {
      expect(dxfeedToWireSymbol("/NQZ26:XCME", "FUTURE")).toBe("/NQZ26:XCME");
      expect(dxfeedToWireSymbol("AAPL", "EQUITY")).toBe("AAPL");
      expect(dxfeedFromWireSymbol("/ESZ26:XCME", "FUTURE")).toBe("/ESZ26:XCME");
      expect(dxfeedFromWireSymbol("TSLA", "EQUITY")).toBe("TSLA");
    });

    test("rejects an unproven symbol or a symbol/assetClass mismatch", () => {
      expect(() => dxfeedToWireSymbol("MSFT", "EQUITY")).toThrow(
        /unsupported symbol/,
      );
      expect(() => dxfeedToWireSymbol("AAPL", "FUTURE")).toThrow(
        /unsupported symbol/,
      );
      expect(() => dxfeedFromWireSymbol("/NQZ26:XCME", "EQUITY")).toThrow(
        /unsupported symbol/,
      );
    });
  });

  describe("dxfeedTradeFrame", () => {
    const fields = {
      symbol: "TSLA",
      assetClass: "EQUITY",
      tsExchange: 1787601599905,
      price: 349.03,
      size: 120,
      side: "buy",
      tradeId: "dx-t-1",
    };

    test("builds a real dxFeed-shaped trade frame, tagged provider DXFEED with assetClass, not marketKind", () => {
      expect(dxfeedTradeFrame(fields)).toEqual({
        type: "trade",
        provider: "DXFEED",
        symbol: "TSLA",
        assetClass: "EQUITY",
        ts_exchange: 1787601599905,
        price: 349.03,
        size: 120,
        side: "buy",
        trade_id: "dx-t-1",
      });
    });

    test("accepts a real futures symbol too, not just equities", () => {
      const frame = dxfeedTradeFrame({
        ...fields,
        symbol: "/NQZ26:XCME",
        assetClass: "FUTURE",
      });
      expect(frame.symbol).toBe("/NQZ26:XCME");
      expect(frame.assetClass).toBe("FUTURE");
    });

    test("rejects an unrecognized assetClass and an invalid side, same discipline as the Binance builders", () => {
      expect(() => dxfeedTradeFrame({ ...fields, assetClass: "SPOT" })).toThrow(
        /asset class/,
      );
      expect(() => dxfeedTradeFrame({ ...fields, side: "BUY" })).toThrow(
        /side/,
      );
    });

    test("rejects an unproven symbol", () => {
      expect(() => dxfeedTradeFrame({ ...fields, symbol: "MSFT" })).toThrow(
        /unsupported symbol/,
      );
    });
  });

  describe("dxfeedMarkerFrame", () => {
    test("mirrors dxfeedTradeFrame's shape, tagged type marker", () => {
      const fields = {
        symbol: "/ESZ26:XCME",
        assetClass: "FUTURE",
        tsExchange: 1787601545023,
        price: 7671.75,
        size: 3,
        side: "sell",
        tradeId: "dx-m-1",
      };
      expect(dxfeedMarkerFrame(fields)).toEqual({
        type: "marker",
        provider: "DXFEED",
        symbol: "/ESZ26:XCME",
        assetClass: "FUTURE",
        ts_exchange: 1787601545023,
        price: 7671.75,
        size: 3,
        side: "sell",
        trade_id: "dx-m-1",
      });
    });

    test("omits the baseline fields entirely rather than sending nulls, when no snapshot is supplied", () => {
      const fields = {
        symbol: "/ESZ26:XCME",
        assetClass: "FUTURE",
        tsExchange: 1787601545023,
        price: 7671.75,
        size: 3,
        side: "sell",
        tradeId: "dx-m-3",
      };
      expect(
        Object.hasOwn(dxfeedMarkerFrame(fields), "baseline_log_median"),
      ).toBe(false);
    });
  });

  describe("dxfeedProfileFrame", () => {
    function engineState({
      mode = "continuous",
      periodStartTs = 1000,
      periodEndTs = null,
      originPrice = 100,
      rowWidth = 1,
      buckets,
    }) {
      const bucketMap = new Map(buckets);
      let maxVolume = -Infinity;
      let pocIndex = null;
      for (const [index, bucket] of bucketMap) {
        if (bucket.volume > maxVolume) {
          maxVolume = bucket.volume;
          pocIndex = index;
        }
      }
      const singlePrintBuckets = [...bucketMap.entries()]
        .filter(([, bucket]) => bucket.volume < maxVolume * SINGLE_PRINT_RATIO)
        .map(([index]) => index);
      return {
        session: {
          periodStartTs,
          periodEndTs,
          rowWidth,
          originPrice,
          buckets: bucketMap,
        },
        profile: {
          pocIndex,
          vaHigh: pocIndex,
          vaLow: pocIndex,
          totalVolume: maxVolume,
          singlePrintBuckets,
        },
        mode,
      };
    }

    test("mirrors profileFrame's shape, tagged provider DXFEED", () => {
      const engine = engineState({
        buckets: [[0, { volume: 5, buyVolume: 3, sellVolume: 2 }]],
      });
      expect(
        dxfeedProfileFrame({
          engineState: engine,
          symbol: "/ESZ26:XCME",
          assetClass: "FUTURE",
        }),
      ).toEqual({
        type: "profile",
        provider: "DXFEED",
        symbol: "/ESZ26:XCME",
        assetClass: "FUTURE",
        mode: "continuous",
        delivery_scope: "LIVE",
        history_request_id: null,
        period_start_ts: 1000,
        period_end_ts: null,
        row_width: 1,
        buckets: [
          {
            price: 100,
            volume: 5,
            buy_volume: 3,
            sell_volume: 2,
            single_print: false,
          },
        ],
        poc_price: 100,
        vah_price: 100,
        val_price: 100,
      });
    });

    test("carries an equity row of tens of millions of shares, which the shared magnitude ceiling would refuse", () => {
      const engine = engineState({
        buckets: [
          [
            0,
            {
              volume: 52_000_000,
              buyVolume: 30_000_000,
              sellVolume: 22_000_000,
            },
          ],
        ],
      });
      const frame = dxfeedProfileFrame({
        engineState: engine,
        symbol: "AAPL",
        assetClass: "EQUITY",
      });
      expect(frame.buckets[0]).toMatchObject({
        volume: 52_000_000,
        buy_volume: 30_000_000,
        sell_volume: 22_000_000,
      });
    });

    test("still refuses a row above the profile volume ceiling, and a price above the magnitude ceiling", () => {
      const huge = engineState({
        buckets: [
          [0, { volume: 2_000_000_000_000, buyVolume: 1, sellVolume: 0 }],
        ],
      });
      expect(() =>
        dxfeedProfileFrame({
          engineState: huge,
          symbol: "AAPL",
          assetClass: "EQUITY",
        }),
      ).toThrow(
        /buckets\.volume: decimal value is outside the supported wire-number range \(value 2000000000000, ceiling 1000000000000\)/,
      );
      const priced = engineState({
        originPrice: 20_000_000,
        buckets: [[0, { volume: 5, buyVolume: 3, sellVolume: 2 }]],
      });
      expect(() =>
        dxfeedProfileFrame({
          engineState: priced,
          symbol: "AAPL",
          assetClass: "EQUITY",
        }),
      ).toThrow(
        /buckets\.price: decimal value is outside the supported wire-number range \(value 20000000, ceiling 10000000\)/,
      );
    });

    test("rejects an unrecognized assetClass, same discipline as the other dxFeed builders", () => {
      const engine = engineState({
        buckets: [[0, { volume: 1, buyVolume: 1, sellVolume: 0 }]],
      });
      expect(() =>
        dxfeedProfileFrame({
          engineState: engine,
          symbol: "TSLA",
          assetClass: "SPOT",
        }),
      ).toThrow(/asset class/);
    });

    test("rejects an unproven symbol", () => {
      const engine = engineState({
        buckets: [[0, { volume: 1, buyVolume: 1, sellVolume: 0 }]],
      });
      expect(() =>
        dxfeedProfileFrame({
          engineState: engine,
          symbol: "MSFT",
          assetClass: "EQUITY",
        }),
      ).toThrow(/unsupported symbol/);
    });

    test("rejects an empty profile", () => {
      const engine = engineState({ buckets: [] });
      expect(() =>
        dxfeedProfileFrame({
          engineState: engine,
          symbol: "TSLA",
          assetClass: "EQUITY",
        }),
      ).toThrow(/at least one bucket/);
    });
  });

  describe("dxfeedVpinFrame", () => {
    function reading(overrides = {}) {
      return {
        sealTs: 1_000,
        active: false,
        direction: null,
        strength: 0,
        zVpin: null,
        zVelocity: null,
        zAcceleration: null,
        activatedAtTs: null,
        ...overrides,
      };
    }

    test("mirrors vpinFrame's shape, tagged provider DXFEED with assetClass", () => {
      const state = reading({
        active: true,
        direction: "sell",
        strength: 0.6,
        zVpin: -1.2,
        activatedAtTs: 900,
      });
      expect(
        dxfeedVpinFrame({
          reading: state,
          symbol: "/ESZ26:XCME",
          assetClass: "FUTURE",
        }),
      ).toEqual({
        type: "vpin",
        provider: "DXFEED",
        symbol: "/ESZ26:XCME",
        assetClass: "FUTURE",
        seal_ts: 1_000,
        active: true,
        direction: "sell",
        strength: 0.6,
        z_vpin: -1.2,
        z_velocity: null,
        z_acceleration: null,
        activated_at_ts: 900,
      });
    });

    test("rejects an unrecognized assetClass, same discipline as the other dxFeed builders", () => {
      expect(() =>
        dxfeedVpinFrame({
          reading: reading(),
          symbol: "TSLA",
          assetClass: "SPOT",
        }),
      ).toThrow(/asset class/);
    });

    test("rejects an unproven symbol", () => {
      expect(() =>
        dxfeedVpinFrame({
          reading: reading(),
          symbol: "MSFT",
          assetClass: "EQUITY",
        }),
      ).toThrow(/unsupported symbol/);
    });

    test("rejects an active reading with no direction", () => {
      expect(() =>
        dxfeedVpinFrame({
          reading: reading({ active: true, strength: 0.4, activatedAtTs: 900 }),
          symbol: "TSLA",
          assetClass: "EQUITY",
        }),
      ).toThrow(/must carry a direction/);
    });
  });

  describe("dxfeedBarFrame", () => {
    const fields = {
      symbol: "/NQZ26:XCME",
      assetClass: "FUTURE",
      tsOpen: 1787714820000,
      open: 29219,
      high: 29225,
      low: 29210,
      close: 29220,
      volume: 12,
      buyVolume: 7,
      tradeCount: 4,
      closed: true,
    };

    test("builds a real dxFeed-shaped bar frame, tagged provider DXFEED with assetClass and a fixed 60s interval", () => {
      expect(dxfeedBarFrame(fields)).toEqual({
        type: "bar",
        provider: "DXFEED",
        symbol: "/NQZ26:XCME",
        assetClass: "FUTURE",
        interval_ms: 60_000,
        ts_open: 1787714820000,
        open: 29219,
        high: 29225,
        low: 29210,
        close: 29220,
        volume: 12,
        trade_count: 4,
        closed: true,
        buy_volume: 7,
      });
    });

    test("an unclosed (live-forming) bar is a valid frame too, matching Binance's own kline stream semantics", () => {
      const frame = dxfeedBarFrame({ ...fields, closed: false });
      expect(frame.closed).toBe(false);
    });

    test("omits buy_volume when it's null, same as Binance's optional takerBuyBaseVolume", () => {
      const frame = dxfeedBarFrame({ ...fields, buyVolume: null });
      expect(Object.hasOwn(frame, "buy_volume")).toBe(false);
    });

    test("buy_volume of exactly 0 is preserved, not treated as absent", () => {
      const frame = dxfeedBarFrame({ ...fields, buyVolume: 0 });
      expect(frame.buy_volume).toBe(0);
    });

    test("rejects internally inconsistent OHLC, same discipline as klineEnvelopeToFrame", () => {
      expect(() => dxfeedBarFrame({ ...fields, high: 29200 })).toThrow(
        /inconsistent/,
      );
    });

    test("rejects a ts_open that doesn't align to the 60s interval", () => {
      expect(() =>
        dxfeedBarFrame({ ...fields, tsOpen: 1787714820123 }),
      ).toThrow(/align/);
    });

    test("rejects an unproven symbol", () => {
      expect(() => dxfeedBarFrame({ ...fields, symbol: "MSFT" })).toThrow(
        /unsupported symbol/,
      );
    });

    test("rejects a negative or non-integer trade_count, same discipline as storageCandleRowToBarFrame", () => {
      expect(() => dxfeedBarFrame({ ...fields, tradeCount: -1 })).toThrow(
        /trade_count/,
      );
      expect(() => dxfeedBarFrame({ ...fields, tradeCount: 1.5 })).toThrow(
        /trade_count/,
      );
    });

    test("rejects a negative volume", () => {
      expect(() =>
        dxfeedBarFrame({ ...fields, volume: -1, buyVolume: 0 }),
      ).toThrow(/wire-number range/);
    });

    test("allows a zero volume bar (a quiet bucket that still closed), same as Binance's own klineEnvelopeToFrame", () => {
      expect(
        dxfeedBarFrame({ ...fields, volume: 0, buyVolume: 0 }).volume,
      ).toBe(0);
    });

    test("accepts institutional equity share volume above the generic magnitude ceiling", () => {
      const frame = dxfeedBarFrame({
        ...fields,
        volume: 25_000_000,
        buyVolume: 12_000_000,
      });
      expect(frame.volume).toBe(25_000_000);
      expect(frame.buy_volume).toBe(12_000_000);
    });

    test("rejects volume above the explicit bar-volume contract ceiling", () => {
      expect(() =>
        dxfeedBarFrame({ ...fields, volume: 1_000_000_000_001, buyVolume: 0 }),
      ).toThrow(/wire-number range/);
    });

    test("rejects a buy_volume that exceeds total volume", () => {
      expect(() => dxfeedBarFrame({ ...fields, buyVolume: 999 })).toThrow(
        /buy volume cannot exceed/,
      );
    });
  });

  describe("storageDxFeedCandleRowToBarFrame", () => {
    test("converts a real dxfeed_candles row into a closed bar frame", () => {
      const row = {
        ts_open: 1787714820000,
        open: 29219,
        high: 29225,
        low: 29210,
        close: 29220,
        volume: 12,
        buy_volume: 7,
        trade_count: 4,
      };
      expect(
        storageDxFeedCandleRowToBarFrame(row, "/NQZ26:XCME", "FUTURE"),
      ).toEqual({
        type: "bar",
        provider: "DXFEED",
        symbol: "/NQZ26:XCME",
        assetClass: "FUTURE",
        interval_ms: 60_000,
        ts_open: 1787714820000,
        open: 29219,
        high: 29225,
        low: 29210,
        close: 29220,
        volume: 12,
        trade_count: 4,
        closed: true,
        buy_volume: 7,
      });
    });

    test("a stored row with a null buy_volume (interim tickDirection-derived quality) omits it from the frame", () => {
      const row = {
        ts_open: 1787714820000,
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume: 1,
        buy_volume: null,
        trade_count: 1,
      };
      expect(
        Object.hasOwn(
          storageDxFeedCandleRowToBarFrame(row, "AAPL", "EQUITY"),
          "buy_volume",
        ),
      ).toBe(false);
    });

    test("never sends a sell side without a buy side, which the browser rejects with the whole snapshot", () => {
      // dxFeed leaves a candle side it saw no volume on as NaN, stored as null. Real host rows, 2026-09-21/23: NQ 05:04
      // volume 17 sell 17 buy null (one such bar dropped the whole 6,885-bar NQ snapshot); AAPL 13:21 volume 1705 sell
      // 1705. A side that is the whole volume leaves exactly 0 for the other; anything short of that stays unknown.
      const base = {
        ts_open: 1789967040000,
        open: 30086,
        high: 30087.75,
        low: 30083.75,
        close: 30084,
        trade_count: 17,
      };
      const nq = storageDxFeedCandleRowToBarFrame(
        { ...base, volume: 17, buy_volume: null, sell_volume: 17 },
        "/NQZ26:XCME",
        "FUTURE",
      );
      expect([nq.buy_volume, nq.sell_volume]).toEqual([0, 17]);
      const aapl = storageDxFeedCandleRowToBarFrame(
        {
          ...base,
          open: 336,
          high: 336,
          low: 336,
          close: 336,
          volume: 1705,
          buy_volume: null,
          sell_volume: 1705,
        },
        "AAPL",
        "EQUITY",
      );
      expect([aapl.buy_volume, aapl.sell_volume]).toEqual([0, 1705]);
      const buyOnly = storageDxFeedCandleRowToBarFrame(
        {
          ...base,
          volume: 30936.457404,
          buy_volume: 30936.457404,
          sell_volume: null,
        },
        "/NQZ26:XCME",
        "FUTURE",
      );
      expect([buyOnly.buy_volume, buyOnly.sell_volume]).toEqual([
        30936.457404, 0,
      ]);
      const partial = storageDxFeedCandleRowToBarFrame(
        { ...base, volume: 100, buy_volume: null, sell_volume: 60 },
        "/NQZ26:XCME",
        "FUTURE",
      );
      expect(
        Object.hasOwn(partial, "buy_volume") ||
          Object.hasOwn(partial, "sell_volume"),
      ).toBe(false);
      for (const frame of [nq, aapl, buyOnly, partial]) {
        expect(
          frame.sell_volume === undefined || frame.buy_volume !== undefined,
        ).toBe(true);
      }
    });
  });

  describe("dxfeedHealthFrame", () => {
    test("builds a real dxFeed health frame, tagged provider DXFEED with assetClass", () => {
      expect(
        dxfeedHealthFrame("AAPL", "EQUITY", {
          stale: false,
          recoveryState: "READY",
        }),
      ).toEqual({
        type: "health",
        provider: "DXFEED",
        symbol: "AAPL",
        assetClass: "EQUITY",
        recoveryState: "READY",
        stale: false,
      });
    });

    test("carries an optional reason, same as the Binance builder", () => {
      const withReason = dxfeedHealthFrame(
        "AAPL",
        "EQUITY",
        { stale: true, recoveryState: "UNAVAILABLE" },
        "SESSION_ENDED",
      );
      expect(withReason.reason).toBe("SESSION_ENDED");
    });

    test("omits printsQuiet entirely when not provided -- Binance frames never carry it either", () => {
      const frame = dxfeedHealthFrame("AAPL", "EQUITY", {
        stale: false,
        recoveryState: "READY",
      });
      expect("printsQuiet" in frame).toBe(false);
    });

    test("carries printsQuiet when explicitly provided, independent of recoveryState", () => {
      const stillRecovering = dxfeedHealthFrame("/NQZ26:XCME", "FUTURE", {
        stale: true,
        recoveryState: "RECOVERING",
        printsQuiet: true,
      });
      expect(stillRecovering.printsQuiet).toBe(true);
      const wentQuietAfterReady = dxfeedHealthFrame("/NQZ26:XCME", "FUTURE", {
        stale: false,
        recoveryState: "READY",
        printsQuiet: true,
      });
      expect(wentQuietAfterReady.printsQuiet).toBe(true);
    });

    test("rejects a non-boolean printsQuiet", () => {
      expect(() =>
        dxfeedHealthFrame("AAPL", "EQUITY", {
          stale: false,
          recoveryState: "READY",
          printsQuiet: "true",
        }),
      ).toThrow(/printsQuiet/);
    });
  });

  describe("dxfeedBookFrame", () => {
    test("builds a real dxFeed book frame, tagged provider DXFEED with assetClass", () => {
      const orderBookState = {
        status: "READY",
        book: { bids: [["100", "1"]], asks: [["101", "1"]], lastUpdateId: 1 },
      };
      expect(dxfeedBookFrame("/NQZ26:XCME", "FUTURE", orderBookState)).toEqual({
        type: "book",
        provider: "DXFEED",
        symbol: "/NQZ26:XCME",
        assetClass: "FUTURE",
        status: "READY",
        bids: [{ price: 100, size: 1 }],
        asks: [{ price: 101, size: 1 }],
        lastUpdateId: 1,
        stale: false,
      });
    });

    test("rejects a crossed book, same discipline as the Binance builder", () => {
      const orderBookState = {
        status: "READY",
        book: { bids: [["101", "1"]], asks: [["100", "1"]], lastUpdateId: 1 },
      };
      expect(() => dxfeedBookFrame("AAPL", "EQUITY", orderBookState)).toThrow(
        /crossed/,
      );
    });

    test("builds a valid UNAVAILABLE frame with a reason, no bids/asks/lastUpdateId fields at all", () => {
      const frame = dxfeedBookFrame("AAPL", "EQUITY", {
        status: "UNAVAILABLE",
        reason: "CONNECTION_DOWN",
      });
      expect(frame).toEqual({
        type: "book",
        provider: "DXFEED",
        symbol: "AAPL",
        assetClass: "EQUITY",
        status: "UNAVAILABLE",
        reason: "CONNECTION_DOWN",
      });
      expect(frame).not.toHaveProperty("bids");
      expect(frame).not.toHaveProperty("asks");
      expect(frame).not.toHaveProperty("lastUpdateId");
    });

    test.each(["ORDER_CAP_EXCEEDED", "ORDER_CAPTURE_ERROR"])(
      "represents dxFeed L2 integrity reason %s without levels",
      (reason) => {
        const frame = dxfeedBookFrame("AAPL", "EQUITY", {
          status: "UNAVAILABLE",
          reason,
        });
        expect(frame).toEqual({
          type: "book",
          provider: "DXFEED",
          symbol: "AAPL",
          assetClass: "EQUITY",
          status: "UNAVAILABLE",
          reason,
        });
        expect(frame).not.toHaveProperty("bids");
        expect(frame).not.toHaveProperty("asks");
      },
    );

    test("rejects UNAVAILABLE without a reason -- same discipline as the Binance builder", () => {
      expect(() =>
        dxfeedBookFrame("AAPL", "EQUITY", { status: "UNAVAILABLE" }),
      ).toThrow(/reason/);
    });

    test("rejects a status that is neither READY nor UNAVAILABLE rather than mapping it to an empty-reason UNAVAILABLE", () => {
      expect(() =>
        dxfeedBookFrame("AAPL", "EQUITY", { status: "BUFFERING" }),
      ).toThrow(/READY or UNAVAILABLE/);
    });
  });

  describe("dxfeedSelectionFrame", () => {
    test("builds the wire shape announcing the currently active dxFeed symbol", () => {
      expect(dxfeedSelectionFrame("TSLA", "EQUITY")).toEqual({
        type: "selection",
        provider: "DXFEED",
        symbol: "TSLA",
        assetClass: "EQUITY",
      });
    });
  });

  describe("dxfeedSnapshotFrame", () => {
    test("wraps dxFeed trades and markers into the wire shape", () => {
      const trade = dxfeedTradeFrame({
        symbol: "AAPL",
        assetClass: "EQUITY",
        tsExchange: 1,
        price: 310.48,
        size: 1,
        side: "sell",
        tradeId: "dx-s-1",
      });
      const marker = dxfeedMarkerFrame({
        symbol: "AAPL",
        assetClass: "EQUITY",
        tsExchange: 1,
        price: 310.48,
        size: 1,
        side: "sell",
        tradeId: "dx-s-2",
      });
      expect(
        dxfeedSnapshotFrame([], [trade], "AAPL", "EQUITY", [marker]),
      ).toEqual({
        type: "snapshot",
        provider: "DXFEED",
        symbol: "AAPL",
        assetClass: "EQUITY",
        bars: [],
        trades: [trade],
        markers: [marker],
      });
    });

    test("rejects a cross-provider spoof -- a Binance-tagged trade cannot ride inside a dxFeed snapshot", () => {
      const binanceTrade = tradeEnvelopeToFrame(
        normalizeTrade(REAL_SPOT_TRADE),
      );
      expect(() =>
        dxfeedSnapshotFrame([], [binanceTrade], "AAPL", "EQUITY"),
      ).toThrow(/pair-matched/);
    });

    test("an empty dxFeed snapshot is valid, same as Binance's", () => {
      expect(dxfeedSnapshotFrame([], [], "TSLA", "EQUITY")).toEqual({
        type: "snapshot",
        provider: "DXFEED",
        symbol: "TSLA",
        assetClass: "EQUITY",
        bars: [],
        trades: [],
        markers: [],
      });
    });

    test("discloses an incomplete observed-bar history without inventing empty candles", () => {
      expect(
        dxfeedSnapshotFrame([], [], "AAPL", "EQUITY", [], {
          availability: "AVAILABLE",
          requestedStartTsOpen: 1_800_000_000_000,
          earliestObservedTsOpen: 1_800_086_400_000,
          coverage: "START_NOT_COVERED",
        }),
      ).toEqual(
        expect.objectContaining({
          bar_history: {
            availability: "AVAILABLE",
            requestedStartTsOpen: 1_800_000_000_000,
            earliestObservedTsOpen: 1_800_086_400_000,
            coverage: "START_NOT_COVERED",
            interpretation: "OBSERVED_NONEMPTY_BARS_ONLY",
          },
        }),
      );
    });

    test("rejects a malformed observed-bar history descriptor", () => {
      expect(() =>
        dxfeedSnapshotFrame([], [], "AAPL", "EQUITY", [], {
          availability: "AVAILABLE",
          requestedStartTsOpen: 1,
          coverage: "UNKNOWN",
        }),
      ).toThrow(/barHistory is invalid/);
    });

    test("rejects internally contradictory observed-bar history descriptors", () => {
      const invalid = [
        {
          availability: "AVAILABLE",
          requestedStartTsOpen: 10,
          coverage: "NO_ROWS",
          earliestObservedTsOpen: 11,
        },
        {
          availability: "AVAILABLE",
          requestedStartTsOpen: 10,
          coverage: "START_COVERED",
        },
        {
          availability: "UNAVAILABLE",
          requestedStartTsOpen: 10,
          coverage: "START_NOT_COVERED",
          earliestObservedTsOpen: 11,
        },
        {
          availability: "AVAILABLE",
          requestedStartTsOpen: 10,
          coverage: "START_NOT_COVERED",
          earliestObservedTsOpen: 9,
        },
      ];
      for (const barHistory of invalid) {
        expect(() =>
          dxfeedSnapshotFrame([], [], "AAPL", "EQUITY", [], barHistory),
        ).toThrow(/barHistory is invalid/);
      }
    });

    test("enforces the same collection bounds as the client parser", () => {
      const trade = dxfeedTradeFrame({
        symbol: "AAPL",
        assetClass: "EQUITY",
        tsExchange: 1,
        price: 1,
        size: 1,
        side: "buy",
        tradeId: "1",
      });
      expect(() =>
        dxfeedSnapshotFrame([], Array(101).fill(trade), "AAPL", "EQUITY"),
      ).toThrow(/at most 100/);
      expect(() =>
        dxfeedSnapshotFrame([], [], "AAPL", "EQUITY", Array(5_001).fill(trade)),
      ).toThrow(/at most 5000/);
    });

    test("omits vpin_readings entirely when the caller doesn't pass it", () => {
      expect(
        Object.hasOwn(
          dxfeedSnapshotFrame([], [], "AAPL", "EQUITY"),
          "vpin_readings",
        ),
      ).toBe(false);
    });

    test("carries the VPIN lifecycle status alongside an optional history", () => {
      expect(
        dxfeedSnapshotFrame(
          [],
          [],
          "AAPL",
          "EQUITY",
          [],
          undefined,
          undefined,
          "UNAVAILABLE",
        ).vpin_status,
      ).toBe("UNAVAILABLE");
    });

    test("carries a chronological backfilled vpin_readings array when supplied, alongside bar_history", () => {
      const readings = [
        {
          sealTs: 100,
          active: true,
          direction: "sell",
          strength: 0.2,
          zVpin: -1.05,
          zVelocity: null,
          zAcceleration: null,
          activatedAtTs: 100,
        },
      ];
      const frame = dxfeedSnapshotFrame(
        [],
        [],
        "AAPL",
        "EQUITY",
        [],
        undefined,
        readings,
      );
      expect(frame.vpin_readings).toEqual([
        {
          seal_ts: 100,
          active: true,
          direction: "sell",
          strength: 0.2,
          z_vpin: -1.05,
          z_velocity: null,
          z_acceleration: null,
          activated_at_ts: 100,
        },
      ]);
    });

    test("rejects vpin_readings that go backward in time", () => {
      const readings = [
        {
          sealTs: 200,
          active: false,
          direction: null,
          strength: 0,
          zVpin: null,
          zVelocity: null,
          zAcceleration: null,
          activatedAtTs: null,
        },
        {
          sealTs: 100,
          active: false,
          direction: null,
          strength: 0,
          zVpin: null,
          zVelocity: null,
          zAcceleration: null,
          activatedAtTs: null,
        },
      ];
      expect(() =>
        dxfeedSnapshotFrame([], [], "AAPL", "EQUITY", [], undefined, readings),
      ).toThrow(/chronological/);
    });

    test("accepts two readings sharing the same seal_ts -- two buckets can legitimately seal within the same millisecond during a burst", () => {
      const readings = [
        {
          sealTs: 100,
          active: false,
          direction: null,
          strength: 0,
          zVpin: null,
          zVelocity: null,
          zAcceleration: null,
          activatedAtTs: null,
        },
        {
          sealTs: 100,
          active: true,
          direction: "sell",
          strength: 0.3,
          zVpin: -1.1,
          zVelocity: null,
          zAcceleration: null,
          activatedAtTs: 100,
        },
      ];
      expect(() =>
        dxfeedSnapshotFrame([], [], "AAPL", "EQUITY", [], undefined, readings),
      ).not.toThrow();
    });
  });
});

describe("aggressiveHistoryFrame", () => {
  const binanceTrade = (ts) =>
    storageTradeRowToTradeFrame(
      { ts, price: "100.5", size: "2", side: "buy", trade_id: String(ts) },
      "BTCUSDT",
      "SPOT",
    );
  const nqTrade = (ts) =>
    dxfeedTradeFrame({
      symbol: "/NQZ26:XCME",
      assetClass: "FUTURE",
      tsExchange: ts,
      price: 29100,
      size: 3,
      side: "sell",
      tradeId: "/NQZ26:XCME:" + ts + ":0:1",
    });
  const args = {
    requestId: 4,
    fromTs: 1000,
    toTs: 5000,
    minSize: 2,
    complete: true,
  };

  test("carries the selection identity, the request echo and the trades oldest first, frozen", () => {
    const frame = aggressiveHistoryFrame(
      { provider: "BINANCE", symbol: "BTCUSDT", marketKind: "SPOT" },
      { ...args, trades: [binanceTrade(1000), binanceTrade(2000)] },
    );
    expect(frame).toEqual({
      type: "aggressive_history",
      provider: "BINANCE",
      symbol: "BTC-USDT",
      marketKind: "SPOT",
      request_id: 4,
      from_ts: 1000,
      to_ts: 5000,
      min_size: 2,
      complete: true,
      reason: null,
      next_cursor: null,
      retry_after_ms: null,
      trades: [binanceTrade(1000), binanceTrade(2000)],
    });
    expect(Object.isFrozen(frame)).toBe(true);
    expect(Object.isFrozen(frame.trades)).toBe(true);
    const dx = aggressiveHistoryFrame(
      { provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" },
      {
        ...args,
        complete: false,
        reason: "CAP_REACHED",
        nextCursor: "eyJ2IjoxfQ",
        trades: [nqTrade(1000)],
      },
    );
    expect(dx).toMatchObject({
      provider: "DXFEED",
      symbol: "/NQZ26:XCME",
      assetClass: "FUTURE",
      complete: false,
      reason: "CAP_REACHED",
      next_cursor: "eyJ2IjoxfQ",
    });
    for (const reason of AGGRESSIVE_HISTORY_REASONS) {
      expect(
        aggressiveHistoryFrame(
          { provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" },
          {
            ...args,
            complete: false,
            reason,
            ...(reason === "CAP_REACHED" ? { nextCursor: "eyJ2IjoxfQ" } : {}),
            trades: [],
          },
        ).reason,
      ).toBe(reason);
    }
  });

  test("an incomplete reply must say why, a complete one must not, and the reason is one of the closed vocabulary", () => {
    const identity = {
      provider: "BINANCE",
      symbol: "BTCUSDT",
      marketKind: "SPOT",
    };
    expect(() =>
      aggressiveHistoryFrame(identity, {
        ...args,
        complete: false,
        trades: [],
      }),
    ).toThrow(/reason/);
    expect(() =>
      aggressiveHistoryFrame(identity, {
        ...args,
        complete: false,
        reason: "NOPE",
        trades: [],
      }),
    ).toThrow(/reason/);
    expect(() =>
      aggressiveHistoryFrame(identity, {
        ...args,
        complete: true,
        reason: "CAP_REACHED",
        trades: [],
      }),
    ).toThrow(/reason/);
    expect(() =>
      aggressiveHistoryFrame(identity, {
        ...args,
        complete: false,
        reason: "CAP_REACHED",
        trades: [],
      }),
    ).toThrow(/nextCursor/);
    expect(() =>
      aggressiveHistoryFrame(identity, {
        ...args,
        complete: false,
        reason: "READ_FAILED",
        nextCursor: "eyJ2IjoxfQ",
        trades: [],
      }),
    ).toThrow(/nextCursor/);
    expect(() =>
      aggressiveHistoryFrame(identity, {
        ...args,
        complete: true,
        retryAfterMs: 1,
        trades: [],
      }),
    ).toThrow(/retryAfterMs/);
    expect(() =>
      aggressiveHistoryFrame(identity, {
        ...args,
        complete: false,
        reason: "OVERLOADED",
        retryAfterMs: 0,
        trades: [],
      }),
    ).toThrow(/retryAfterMs/);
    expect(
      aggressiveHistoryFrame(identity, {
        ...args,
        complete: false,
        reason: "OVERLOADED",
        retryAfterMs: 1234,
        trades: [],
      }).retry_after_ms,
    ).toBe(1234);
  });

  test("rejects a bad identity, bad numbers, too many trades, a foreign trade, and trades out of order", () => {
    const identity = {
      provider: "BINANCE",
      symbol: "BTCUSDT",
      marketKind: "SPOT",
    };
    expect(() =>
      aggressiveHistoryFrame({ provider: "X" }, { ...args, trades: [] }),
    ).toThrow(/provider/);
    expect(() =>
      aggressiveHistoryFrame(identity, { ...args, requestId: -1, trades: [] }),
    ).toThrow(/requestId/);
    expect(() =>
      aggressiveHistoryFrame(identity, { ...args, toTs: 1000, trades: [] }),
    ).toThrow(/toTs/);
    expect(() =>
      aggressiveHistoryFrame(identity, { ...args, minSize: -0.5, trades: [] }),
    ).toThrow(/minSize/);
    expect(() =>
      aggressiveHistoryFrame(identity, {
        ...args,
        complete: "yes",
        trades: [],
      }),
    ).toThrow(/complete/);
    expect(() =>
      aggressiveHistoryFrame(identity, {
        ...args,
        trades: new Array(MAX_AGGRESSIVE_HISTORY_TRADES + 1).fill(
          binanceTrade(1),
        ),
      }),
    ).toThrow(/at most/);
    expect(() =>
      aggressiveHistoryFrame(identity, { ...args, trades: [nqTrade(1000)] }),
    ).toThrow(/same instrument/);
    expect(() =>
      aggressiveHistoryFrame(identity, {
        ...args,
        trades: [binanceTrade(2000), binanceTrade(1000)],
      }),
    ).toThrow(/oldest first/);
  });
});

describe("frameKindOf", () => {
  test("classifies control, latest-state, incremental, and bulk-history types", () => {
    expect(frameKindOf({ type: "selection" })).toBe(FRAME_KIND_CONTROL);
    expect(frameKindOf({ type: "health" })).toBe(FRAME_KIND_CONTROL);
    expect(frameKindOf({ type: "analytics_status" })).toBe(FRAME_KIND_CONTROL);
    expect(frameKindOf({ type: "book" })).toBe(FRAME_KIND_LATEST_STATE);
    expect(frameKindOf({ type: "bar" })).toBe(FRAME_KIND_LATEST_STATE);
    expect(frameKindOf({ type: "vpin" })).toBe(FRAME_KIND_LATEST_STATE);
    expect(frameKindOf({ type: "trade" })).toBe(FRAME_KIND_INCREMENTAL);
    expect(frameKindOf({ type: "marker" })).toBe(FRAME_KIND_INCREMENTAL);
    expect(frameKindOf({ type: "liquidity" })).toBe(FRAME_KIND_INCREMENTAL);
    expect(frameKindOf({ type: "snapshot" })).toBe(FRAME_KIND_LATEST_STATE);
    expect(frameKindOf({ type: "aggressive_history" })).toBe(
      FRAME_KIND_BULK_HISTORY,
    );
    expect(frameKindOf({ type: "marker_history" })).toBe(
      FRAME_KIND_BULK_HISTORY,
    );
  });

  test("sends a delta profile's history as bulk history, so it yields to live frames on a slow client", () => {
    expect(frameKindOf({ type: "delta_profile" })).toBe(FRAME_KIND_BULK_HISTORY);
  });

  test("sends band history as bulk history, so a slow client cannot prioritize its large pages over live frames", () => {
    expect(frameKindOf({ type: "band_history" })).toBe(FRAME_KIND_BULK_HISTORY);
  });

  test("classifies profile frames by delivery_scope, not just type", () => {
    expect(frameKindOf({ type: "profile", delivery_scope: "LIVE" })).toBe(
      FRAME_KIND_LATEST_STATE,
    );
    expect(frameKindOf({ type: "profile", delivery_scope: "HISTORICAL" })).toBe(
      FRAME_KIND_BULK_HISTORY,
    );
    expect(
      frameKindOf({ type: "profile", delivery_scope: "FIXED_RANGE" }),
    ).toBe(FRAME_KIND_BULK_HISTORY);
  });

  test("an unrecognized frame type defaults to incremental, not a prioritized kind", () => {
    expect(frameKindOf({ type: "something_new" })).toBe(FRAME_KIND_INCREMENTAL);
    expect(frameKindOf(null)).toBe(FRAME_KIND_INCREMENTAL);
  });
});

describe("markerHistoryFrame", () => {
  const identity = {
    provider: "BINANCE",
    symbol: "BTCUSDT",
    marketKind: "SPOT",
  };
  const marker = (index, overrides = {}) =>
    markerFrame(
      {
        ts_exchange: 1_700_000_000_000 + index * 1_000,
        price: "64000.5",
        size: "1.25",
        side: index % 2 ? "buy" : "sell",
        trade_id: `m-${index}`,
        ...overrides,
      },
      "BTCUSDT",
      "SPOT",
    );

  test("carries markers as positional rows with the frame's identity hoisted, a third the size of marker frames", () => {
    const markers = Array.from({ length: 1_000 }, (_, index) => marker(index));
    const frame = markerHistoryFrame(identity, {
      reset: true,
      seq: 0,
      markers,
    });
    expect(frame).toMatchObject({
      type: "marker_history",
      provider: "BINANCE",
      symbol: "BTC-USDT",
      marketKind: "SPOT",
      reset: true,
      seq: 0,
    });
    expect(frame.rows).toHaveLength(1_000);
    expect(frame.rows[1]).toEqual([
      1_700_000_001_000,
      64000.5,
      1.25,
      "b",
      "m-1",
    ]);
    expect(
      Object.isFrozen(frame) &&
        Object.isFrozen(frame.rows) &&
        Object.isFrozen(frame.rows[0]),
    ).toBe(true);
    expect(JSON.stringify(frame).length * 3).toBeLessThan(
      JSON.stringify(markers).length,
    );
  });

  test("refuses the wrong instrument, disorder, duplicates, an oversized page, and bad flags", () => {
    const okay = [marker(0), marker(1)];
    expect(() =>
      markerHistoryFrame(
        { provider: "BINANCE", symbol: "ETHUSDT", marketKind: "SPOT" },
        { reset: true, seq: 0, markers: okay },
      ),
    ).toThrow(/same instrument/);
    expect(() =>
      markerHistoryFrame(
        { ...identity, marketKind: "PERPETUAL" },
        { reset: true, seq: 0, markers: okay },
      ),
    ).toThrow(/same instrument/);
    expect(() =>
      markerHistoryFrame(identity, {
        reset: true,
        seq: 0,
        markers: [marker(1), marker(0)],
      }),
    ).toThrow(/oldest first/);
    expect(() =>
      markerHistoryFrame(identity, {
        reset: true,
        seq: 0,
        markers: [marker(0), marker(1, { trade_id: "m-0" })],
      }),
    ).toThrow(/unique/);
    expect(() =>
      markerHistoryFrame(identity, {
        reset: true,
        seq: 0,
        markers: Array.from({ length: MAX_MARKER_HISTORY_ROWS + 1 }, (_, i) =>
          marker(i),
        ),
      }),
    ).toThrow(/at most 5000/);
    expect(() =>
      markerHistoryFrame(identity, { reset: "yes", seq: 0, markers: okay }),
    ).toThrow(/reset must be a boolean/);
    expect(() =>
      markerHistoryFrame(identity, { reset: true, seq: -1, markers: okay }),
    ).toThrow(/seq must be/);
    expect(() =>
      markerHistoryFrame(
        { provider: "NOPE", symbol: "BTCUSDT" },
        { reset: true, seq: 0, markers: okay },
      ),
    ).toThrow(/invalid provider/);
    expect(
      markerHistoryFrame(
        { provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" },
        {
          reset: false,
          seq: 4,
          markers: [
            dxfeedMarkerFrame({
              symbol: "/NQZ26:XCME",
              assetClass: "FUTURE",
              tsExchange: 5,
              price: 20000,
              size: 3,
              side: "buy",
              tradeId: "d-1",
            }),
          ],
        },
      ),
    ).toMatchObject({
      provider: "DXFEED",
      assetClass: "FUTURE",
      reset: false,
      seq: 4,
      rows: [[5, 20000, 3, "b", "d-1"]],
    });
    expect(() =>
      markerHistoryFrame(
        { provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" },
        {
          reset: false,
          seq: 4,
          markers: [
            dxfeedMarkerFrame({
              symbol: "/NQZ26:XCME",
              assetClass: "FUTURE",
              tsExchange: 5,
              price: 20000,
              size: 3,
              side: "buy",
              tradeId: "d-1",
            }),
          ],
        },
      ),
    ).toThrow(/same instrument/);
  });

  test("pages a retained set into reset-first chunks of at most the page cap, and sends nothing for an empty set", () => {
    const markers = Array.from({ length: 12_000 }, (_, index) => marker(index));
    const pages = markerHistoryFrames(identity, markers);
    expect(
      pages.map((page) => [page.reset, page.seq, page.rows.length]),
    ).toEqual([
      [true, 0, 5_000],
      [false, 1, 5_000],
      [false, 2, 2_000],
    ]);
    expect(pages.flatMap((page) => page.rows.map((row) => row[4]))).toEqual(
      markers.map((m) => m.trade_id),
    );
    expect(markerHistoryFrames(identity, [])).toEqual([]);
    expect(
      markerHistoryFrames(identity, markers.slice(0, 7), { chunkRows: 3 }).map(
        (page) => page.rows.length,
      ),
    ).toEqual([3, 3, 1]);
    expect(() =>
      markerHistoryFrames(identity, markers, { chunkRows: 0 }),
    ).toThrow(/chunkRows/);
    expect(MAX_SNAPSHOT_MARKERS).toBe(MAX_MARKER_HISTORY_ROWS);
  });
});

describe("bandHistoryFrame", () => {
  const { bandHistoryFrame, BAND_HISTORY_REASONS, MAX_BAND_HISTORY_COLUMNS, MAX_BAND_HISTORY_ROWS } = require("../../src/server/frames");
  const identity = { provider: "BINANCE", symbol: "BTCUSDT", marketKind: "SPOT" };
  const column = (ts, rows = 3) => ({ ts, bid: new Array(rows).fill(1.5), ask: new Array(rows).fill(0), buy: new Array(rows).fill(0), sell: new Array(rows).fill(0.25) });
  const args = { requestId: 4, fromTs: 1_000, toTs: 61_000, priceLo: 80_000, priceHi: 80_008, columnMs: 10_000, rowWidth: 4, rowLo: 20_000, rowHi: 20_002, complete: true };

  test("carries the selection identity, the request echo, the band's rows and the columns ascending, frozen", () => {
    const frame = bandHistoryFrame(identity, { ...args, columns: [column(11_000), column(21_000)] });
    expect(frame).toEqual({
      type: "band_history", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT",
      request_id: 4, from_ts: 1_000, to_ts: 61_000, price_lo: 80_000, price_hi: 80_008, column_ms: 10_000, row_width: 4, row_lo: 20_000, row_hi: 20_002,
      complete: true, reason: null, retry_after_ms: null, columns: [column(11_000), column(21_000)],
    });
    expect(Object.isFrozen(frame)).toBe(true);
    expect(Object.isFrozen(frame.columns)).toBe(true);
    expect(Object.isFrozen(frame.columns[0].bid)).toBe(true);
    const dx = bandHistoryFrame({ provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" }, { ...args, columns: [] });
    expect(dx).toMatchObject({ provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE", columns: [] });
    for (const reason of BAND_HISTORY_REASONS) {
      const geometry = ["GEOMETRY_UNAVAILABLE", "BAND_TOO_WIDE", "BAD_REQUEST"].includes(reason) ? { rowWidth: null, rowLo: null, rowHi: null } : {};
      expect(bandHistoryFrame(identity, { ...args, ...geometry, complete: false, reason, columns: [] }).reason).toBe(reason);
    }
  });

  test("an incomplete reply must say why and carry no columns; a complete one must not; the geometry is null only when unavailable", () => {
    expect(() => bandHistoryFrame(identity, { ...args, complete: false, columns: [] })).toThrow(/reason/);
    expect(() => bandHistoryFrame(identity, { ...args, complete: false, reason: "NOPE", columns: [] })).toThrow(/reason/);
    expect(() => bandHistoryFrame(identity, { ...args, complete: true, reason: "READ_FAILED", columns: [] })).toThrow(/reason/);
    expect(() => bandHistoryFrame(identity, { ...args, complete: false, reason: "READ_FAILED", columns: [column(11_000)] })).toThrow(/no columns/);
    expect(() => bandHistoryFrame(identity, { ...args, complete: true, retryAfterMs: 1, columns: [] })).toThrow(/retryAfterMs/);
    expect(() => bandHistoryFrame(identity, { ...args, complete: false, reason: "OVERLOADED", retryAfterMs: 0, columns: [] })).toThrow(/retryAfterMs/);
    expect(bandHistoryFrame(identity, { ...args, complete: false, reason: "OVERLOADED", retryAfterMs: 1234, columns: [] }).retry_after_ms).toBe(1234);
    expect(() => bandHistoryFrame(identity, { ...args, rowWidth: null, rowLo: null, rowHi: null, columns: [] })).toThrow(/rowWidth/);
    expect(() => bandHistoryFrame(identity, { ...args, complete: false, reason: "GEOMETRY_UNAVAILABLE", columns: [] })).toThrow(/null when the geometry/);
  });

  test("rejects a bad identity, bad numbers, a band over the row cap, too many columns, a column of the wrong width, a negative or out-of-order value", () => {
    expect(() => bandHistoryFrame({ provider: "X" }, { ...args, columns: [] })).toThrow(/provider/);
    expect(() => bandHistoryFrame(identity, { ...args, priceHi: 79_999, columns: [] })).toThrow(/priceHi/);
    expect(() => bandHistoryFrame(identity, { ...args, columnMs: 0, columns: [] })).toThrow(/columnMs/);
    expect(() => bandHistoryFrame(identity, { ...args, rowHi: 20_000 + MAX_BAND_HISTORY_ROWS, columns: [] })).toThrow(/rows/);
    expect(() => bandHistoryFrame(identity, { ...args, columns: Array.from({ length: MAX_BAND_HISTORY_COLUMNS + 1 }, (_unused, i) => column(i + 1)) })).toThrow(/columns/);
    expect(() => bandHistoryFrame(identity, { ...args, columns: [column(11_000, 2)] })).toThrow(/one value per row/);
    expect(() => bandHistoryFrame(identity, { ...args, columns: [{ ...column(11_000), bid: [1, -1, 1] }] })).toThrow(/non-negative/);
    expect(() => bandHistoryFrame(identity, { ...args, columns: [column(21_000), column(11_000)] })).toThrow(/ascending/);
  });
});

describe("deltaProfileFrame", () => {
  const { deltaProfileFrame, DELTA_PROFILE_REASONS, MAX_DELTA_PROFILE_ROWS } = require("../../src/server/frames");
  const { MAX_PROFILE_VOLUME } = require("../../src/server/wire-fields");
  const identity = { provider: "BINANCE", symbol: "BTCUSDT", marketKind: "PERPETUAL" };
  const args = { requestId: 9, fromTs: 1_000, toTs: 5_000, rowWidth: 1, complete: true, pending: 2 };

  test("carries the selection identity, the piece echo and the rows ascending, frozen", () => {
    const frame = deltaProfileFrame(identity, { ...args, rows: [[84_610, 12.4, 3.1], [84_611, 0, 7.75]] });
    expect(frame).toEqual({
      type: "delta_profile", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "PERPETUAL",
      request_id: 9, from_ts: 1_000, to_ts: 5_000, row_width: 1, complete: true, reason: null, retry_after_ms: null, pending: 2,
      rows: [[84_610, 12.4, 3.1], [84_611, 0, 7.75]],
    });
    expect(Object.isFrozen(frame)).toBe(true);
    expect(Object.isFrozen(frame.rows)).toBe(true);
    expect(Object.isFrozen(frame.rows[0])).toBe(true);
    const dx = deltaProfileFrame({ provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" }, { ...args, rowWidth: 0.25, rows: [] });
    expect(dx).toMatchObject({ provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE", row_width: 0.25, rows: [] });
    for (const reason of DELTA_PROFILE_REASONS) {
      expect(deltaProfileFrame(identity, { ...args, complete: false, reason, rows: [] }).reason).toBe(reason);
    }
  });

  test("an incomplete piece must say why and carry no rows; a complete one must not; retryAfterMs only with OVERLOADED", () => {
    expect(() => deltaProfileFrame(identity, { ...args, complete: false, rows: [] })).toThrow(/reason/);
    expect(() => deltaProfileFrame(identity, { ...args, complete: false, reason: "NOPE", rows: [] })).toThrow(/reason/);
    expect(() => deltaProfileFrame(identity, { ...args, complete: true, reason: "READ_FAILED", rows: [] })).toThrow(/reason/);
    expect(() => deltaProfileFrame(identity, { ...args, complete: false, reason: "READ_FAILED", rows: [[1, 1, 1]] })).toThrow(/no rows/);
    expect(() => deltaProfileFrame(identity, { ...args, retryAfterMs: 1, rows: [] })).toThrow(/retryAfterMs/);
    expect(() => deltaProfileFrame(identity, { ...args, complete: false, reason: "OVERLOADED", retryAfterMs: 0, rows: [] })).toThrow(/retryAfterMs/);
    expect(deltaProfileFrame(identity, { ...args, complete: false, reason: "OVERLOADED", retryAfterMs: 1234, rows: [] }).retry_after_ms).toBe(1234);
  });

  test("rejects a bad identity, bad numbers, a bad pending, too many rows, a malformed row, a non-ascending price, a volume off the ceiling", () => {
    expect(() => deltaProfileFrame({ provider: "X" }, { ...args, rows: [] })).toThrow(/provider/);
    expect(() => deltaProfileFrame(identity, { ...args, requestId: -1, rows: [] })).toThrow(/requestId/);
    expect(() => deltaProfileFrame(identity, { ...args, toTs: 1_000, rows: [] })).toThrow(/toTs/);
    expect(() => deltaProfileFrame(identity, { ...args, rowWidth: 0, rows: [] })).toThrow(/rowWidth/);
    expect(() => deltaProfileFrame(identity, { ...args, complete: "yes", rows: [] })).toThrow(/complete/);
    expect(() => deltaProfileFrame(identity, { ...args, pending: -1, rows: [] })).toThrow(/pending/);
    expect(() => deltaProfileFrame(identity, { ...args, rows: Array.from({ length: MAX_DELTA_PROFILE_ROWS + 1 }, (_unused, i) => [i + 1, 0, 0]) })).toThrow(/rows/);
    expect(() => deltaProfileFrame(identity, { ...args, rows: [[1, 1]] })).toThrow(/\[price, buy, sell\]/);
    expect(() => deltaProfileFrame(identity, { ...args, rows: [[0, 1, 1]] })).toThrow(/price/);
    expect(() => deltaProfileFrame(identity, { ...args, rows: [[2, 1, 1], [2, 1, 1]] })).toThrow(/ascending/);
    expect(() => deltaProfileFrame(identity, { ...args, rows: [[1, -1, 1]] })).toThrow(/volumes/);
    expect(() => deltaProfileFrame(identity, { ...args, rows: [[1, 1, MAX_PROFILE_VOLUME + 1]] })).toThrow(/volumes/);
  });
});
