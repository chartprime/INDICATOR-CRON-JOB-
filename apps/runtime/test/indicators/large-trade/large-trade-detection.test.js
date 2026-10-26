const {
  usesContractMagnitude,
  tradeMagnitude,
  markerMagnitude,
  lowerMagnitudePriority,
  resolveTopFractionCount,
  MARKER_BUCKET_MS,
  MARKERS_PER_BUCKET_SIDE,
  MIN_TOP_FRACTION,
  MAX_TOP_FRACTION,
  DEFAULT_TOP_FRACTION,
} = require("../../../src/indicators/large-trade/large-trade-detection");

describe("server/large-trade-detection", () => {
  describe("the magnitude rule -- the only provider-aware line in the detector", () => {
    test("dxFeed futures measure in contracts, because price is an index point and not a dollar figure", () => {
      expect(usesContractMagnitude("DXFEED", "FUTURE")).toBe(true);
      expect(tradeMagnitude("DXFEED", "FUTURE", 6812.25, 40)).toBe(40);
    });

    test("every other provider and asset class measures in notional", () => {
      expect(usesContractMagnitude("DXFEED", "EQUITY")).toBe(false);
      expect(usesContractMagnitude("BINANCE", "SPOT")).toBe(false);
      expect(usesContractMagnitude("BINANCE", "PERPETUAL")).toBe(false);
      expect(tradeMagnitude("DXFEED", "EQUITY", 220.5, 1_000)).toBe(220_500);
      expect(tradeMagnitude("BINANCE", "PERPETUAL", 60_000, 1.5)).toBe(90_000);
    });

    test("a dxFeed equity is not treated as futures just because the provider matches", () => {
      expect(tradeMagnitude("DXFEED", "EQUITY", 100, 3)).toBe(300);
      expect(tradeMagnitude("DXFEED", "FUTURE", 100, 3)).toBe(3);
    });

    test("markerMagnitude reads the same rule off a marker frame", () => {
      expect(markerMagnitude({ provider: "DXFEED", assetClass: "FUTURE", price: 6812.25, size: 40 })).toBe(40);
      expect(markerMagnitude({ provider: "BINANCE", assetClass: undefined, price: 60_000, size: 1.5 })).toBe(90_000);
    });
  });

  describe("retention ordering -- ranked by magnitude, never by a sentinel", () => {
    const futuresMarker = (size, ts, id) => ({
      provider: "DXFEED", assetClass: "FUTURE", price: 6812.25, size, ts_exchange: ts, trade_id: id,
    });

    test("a smaller futures trade always loses to a larger one, whatever their timestamps", () => {
      expect(lowerMagnitudePriority(futuresMarker(4, 2_000, "b"), futuresMarker(40, 1_000, "a"))).toBe(true);
      expect(lowerMagnitudePriority(futuresMarker(40, 1_000, "a"), futuresMarker(4, 2_000, "b"))).toBe(false);
    });

    test("equal magnitudes fall back to time then trade id, so ordering stays deterministic", () => {
      expect(lowerMagnitudePriority(futuresMarker(10, 1_000, "a"), futuresMarker(10, 2_000, "b"))).toBe(true);
      expect(lowerMagnitudePriority(futuresMarker(10, 1_000, "a"), futuresMarker(10, 1_000, "b"))).toBe(true);
      expect(lowerMagnitudePriority(futuresMarker(10, 1_000, "b"), futuresMarker(10, 1_000, "a"))).toBe(false);
    });

    test("the 1-contract tie mass that broke the z-score orders by time, not arbitrarily", () => {
      // 96% of /NQ prints are exactly 1 contract; ordering among them must still be total.
      const first = futuresMarker(1, 1_000, "a");
      const second = futuresMarker(1, 1_001, "b");
      expect(lowerMagnitudePriority(first, second)).toBe(true);
      expect(lowerMagnitudePriority(second, first)).toBe(false);
    });
  });

  describe("resolveTopFractionCount -- 'top X%' resolved against the real tape", () => {
    test("the target is a share of trades seen, not of markers retained", () => {
      const result = resolveTopFractionCount(10_000, 0.002, 500);
      expect(result.target).toBe(20);
      expect(result.shown).toBe(20);
      expect(result.truncated).toBe(false);
      expect(result.effectiveFraction).toBeCloseTo(0.002, 10);
    });

    test("when retention cannot reach the requested depth it reports the shortfall instead of pretending", () => {
      const result = resolveTopFractionCount(1_000_000, 0.02, 4_000);
      expect(result.target).toBe(20_000);
      expect(result.shown).toBe(4_000);
      expect(result.truncated).toBe(true);
      expect(result.effectiveFraction).toBeCloseTo(0.004, 10);
    });

    test("a non-empty tape always yields at least one marker rather than rounding down to nothing", () => {
      const result = resolveTopFractionCount(100, MIN_TOP_FRACTION, 50);
      expect(result.target).toBe(1);
      expect(result.shown).toBe(1);
    });

    test("an empty tape shows nothing and claims no coverage", () => {
      const result = resolveTopFractionCount(0, DEFAULT_TOP_FRACTION, 0);
      expect(result).toEqual({ target: 0, shown: 0, truncated: false, effectiveFraction: 0 });
    });

    test("invalid inputs are rejected rather than silently producing a threshold", () => {
      expect(() => resolveTopFractionCount(-1, 0.002, 10)).toThrow(/totalTradeCount/);
      expect(() => resolveTopFractionCount(10, 0, 10)).toThrow(/fraction/);
      expect(() => resolveTopFractionCount(10, 1.5, 10)).toThrow(/fraction/);
      expect(() => resolveTopFractionCount(10, 0.002, -1)).toThrow(/availableMarkerCount/);
    });
  });

  describe("calibration constants carry the measured intent", () => {
    test("the default sits at the geometric midpoint of the slider range", () => {
      expect(Math.sqrt(MIN_TOP_FRACTION * MAX_TOP_FRACTION)).toBeCloseTo(DEFAULT_TOP_FRACTION, 12);
    });

    test("retention depth serves the default outright on the busiest measured instrument", () => {
      // BTCUSDT perpetual averages ~3,264 trades per 60s bucket (measured 2026-09-02).
      const busiestBucketTrades = 3_264;
      const perSideAtDefault = (busiestBucketTrades * DEFAULT_TOP_FRACTION) / 2;
      expect(MARKERS_PER_BUCKET_SIDE).toBeGreaterThanOrEqual(Math.ceil(perSideAtDefault));
      expect(MARKER_BUCKET_MS).toBe(60_000);
    });
  });
});
