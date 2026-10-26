const { scanZones, QUALIFYING_MEDIAN_MULTIPLIER, MAX_QUALIFYING_ZONES_PER_SIDE } = require("./l2-zone-scanner");

// bestBid=99, bestAsk=101 -> mid=100, zoneWidth = 100 * 0.0025 = 0.25, scan range [90, 110].
const BIDS = [["99", "5"], ["98", "5"], ["97", "50"], ["89", "1"]];
const ASKS = [["101", "5"], ["102", "5"], ["103", "50"], ["111", "1"]];

describe("scanZones", () => {
  test("computes bestBid/bestAsk/spread directly from the top of book", () => {
    const result = scanZones({ bids: BIDS, asks: ASKS });
    expect(result.bestBid).toBe(99);
    expect(result.bestAsk).toBe(101);
    expect(result.spread).toBe(2);
  });

  test("a zone clearing 1.2x the side's own median qualifies, others don't", () => {
    const result = scanZones({ bids: BIDS, asks: ASKS });
    // sizes in range: 5, 5, 50 -> median 5, threshold 6 -> only the 50 qualifies.
    expect(result.bidZones).toEqual([{ priceBand: 97, size: 50 }]);
    expect(result.askZones).toEqual([{ priceBand: 103, size: 50 }]);
  });

  test("levels outside the +/-10% scan range are excluded from both zones and totals", () => {
    const result = scanZones({ bids: BIDS, asks: ASKS });
    // 89 (bid) and 111 (ask) are outside [90, 110] and must not contribute.
    expect(result.totalBidLiquidity).toBe(5 + 5 + 50);
    expect(result.totalAskLiquidity).toBe(5 + 5 + 50);
  });

  test("no zone qualifies when every zone is close to the median", () => {
    const flatBids = [["99", "10"], ["98", "11"], ["97", "9"], ["96", "10"]];
    const flatAsks = [["101", "10"]];
    const result = scanZones({ bids: flatBids, asks: flatAsks });
    expect(result.bidZones).toEqual([]);
  });

  test("multiple qualifying zones are sorted largest-first", () => {
    const bids = [["99", "1"], ["98", "1"], ["97", "40"], ["96", "1"], ["95", "60"], ["94", "1"]];
    const asks = [["101", "1"]];
    const result = scanZones({ bids, asks });
    expect(result.bidZones.map((zone) => zone.size)).toEqual([60, 40]);
  });

  test("returns null when either side of the book is empty", () => {
    expect(scanZones({ bids: [], asks: ASKS })).toBeNull();
    expect(scanZones({ bids: BIDS, asks: [] })).toBeNull();
    expect(scanZones({ bids: undefined, asks: undefined })).toBeNull();
  });

  test("zone width is fine enough to keep two levels 0.6 apart in separate buckets, not merged into one", () => {
    // mid=100 -> zoneWidth=0.25. 97.8 and 97.2 are 0.6 apart -- comfortably
    // more than zoneWidth, so they must land in different buckets. If they'd
    // been merged into one ~1%-wide bucket instead, the qualifying zone's
    // size would read 41 (1 + 40), not 40.
    const bids = [["99", "1"], ["98", "1"], ["97.8", "1"], ["97.2", "40"], ["96", "1"]];
    const asks = [["101", "1"]];
    const result = scanZones({ bids, asks });
    expect(result.bidZones).toEqual([{ priceBand: 97, size: 40 }]);
  });

  test("total liquidity sums every in-range level, not just the ones that qualify", () => {
    const bids = [["99", "5"], ["98", "5"], ["97", "5"], ["96", "5"]];
    const asks = [["101", "1"]];
    const result = scanZones({ bids, asks });
    expect(result.bidZones).toEqual([]); // all equal size -- median equals every value, nothing clears 1.2x
    expect(result.totalBidLiquidity).toBe(20);
  });

  test("the live multiplier is exported as 1.2, not the earlier 3x default", () => {
    // Pins the constant itself, not just behavior -- a future accidental
    // revert to 3 (or any other value) fails here directly.
    expect(QUALIFYING_MEDIAN_MULTIPLIER).toBe(1.2);
  });

  test("a zone clears the current 1.2x bar even though it would not have cleared the earlier 3x bar", () => {
    // sizes: 10,10,10,10,15 -> median 10. At 1.2x (12), the 15 qualifies.
    // At the earlier 3x (30), it would not have -- this pins the multiplier
    // at 1.2x specifically, not just "some threshold below 15."
    const bids = [["99", "10"], ["98", "10"], ["97", "10"], ["96", "10"], ["95", "15"]];
    const asks = [["101", "1"]];
    const result = scanZones({ bids, asks });
    expect(result.bidZones).toEqual([{ priceBand: 95, size: 15 }]);
    expect(15).toBeGreaterThanOrEqual(10 * QUALIFYING_MEDIAN_MULTIPLIER);
    expect(15).toBeLessThan(10 * 3);
  });

  test("the per-side cap is exported as 35", () => {
    // On a real, well-formed book, this cap can't actually be observed
    // binding: with 0.25%-wide zones across a +/-10% scan range there are
    // at most ~40 occupiable buckets per side, and since the qualifying
    // bar is defined as a multiple of the side's own median, at most half
    // of any distribution can ever clear it (a basic property of the
    // median, confirmed by brute-force search across many synthetic
    // distributions during the closure audit). That caps real qualifying
    // counts at ~20 per side -- so 35 is a deliberate safety margin well
    // above the true ceiling, guaranteeing no legitimate zone is ever
    // silently truncated, not a number expected to bind in practice.
    expect(MAX_QUALIFYING_ZONES_PER_SIDE).toBe(35);
  });

  test("the slice-to-cap mechanism itself keeps only the N largest when fed more qualifying candidates than the cap allows", () => {
    // scanZones bounds bid buckets only by `price >= scanFloor` -- it
    // trusts the exchange's own book ordering (bids sorted best-first, so
    // no bid is ever above bestBid) rather than also bounding bids from
    // above. A real Binance depth snapshot always honors that ordering,
    // so this never matters in production; here it's used deliberately,
    // with bids fed out of natural order, purely to open up more distinct
    // buckets than the ~40-per-side ceiling a well-formed book allows,
    // so the slice(0, MAX_QUALIFYING_ZONES_PER_SIDE) line itself can be
    // exercised past its cap and verified directly.
    const zoneWidth = 550.0005 * 0.0025;
    const bids = [];
    let price = 100;
    while (price < 900) {
      bids.push([price.toFixed(4), "1"]); // background, drags the median down
      price += zoneWidth;
    }
    for (let i = 0; i < 40; i += 1) {
      bids.push([price.toFixed(4), String(1000 + i)]); // 40 distinct qualifying candidates
      price += zoneWidth;
    }
    const asks = [["1000.001", "1"]];

    const result = scanZones({ bids, asks });
    expect(result.bidZones).toHaveLength(MAX_QUALIFYING_ZONES_PER_SIDE);
    // Kept the 35 largest, not an arbitrary 35.
    expect(result.bidZones.map((zone) => zone.size)).toEqual(
      Array.from({ length: MAX_QUALIFYING_ZONES_PER_SIDE }, (_, i) => 1039 - i),
    );
  });
});
