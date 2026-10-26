const {
  alignPeriodStart,
  deriveBucketingParams,
  PROFILE_ORIGIN_PRICE,
} = require("../../../src/indicators/volume-profile/volume-profile-setup");
const {
  MIN_ATR_ROW_COUNT,
  MAX_ATR_ROW_COUNT,
} = require("../../../src/indicators/volume-profile/volume-profile-engine");

const HOUR = 60 * 60 * 1000;
const FOUR_HOURS = 4 * HOUR;
const BAR_MS = 60_000;

function fakeAdapter(priceRange) {
  return { readPriceRange: () => priceRange };
}

describe("alignPeriodStart -- the live period must sit on the same epoch grid the client draws", () => {
  test("snaps an arbitrary wall-clock moment back to its period boundary", () => {
    expect(alignPeriodStart(3 * HOUR + 1234, HOUR)).toBe(3 * HOUR);
  });

  test("a moment already exactly on a boundary is returned unchanged", () => {
    expect(alignPeriodStart(3 * HOUR, HOUR)).toBe(3 * HOUR);
  });

  test("matches the client's own alignedPeriodBoundaries formula for every shipped preset", () => {
    const nowMs = 1_756_700_123_456;
    for (const periodMs of [
      5 * 60_000,
      15 * 60_000,
      30 * 60_000,
      HOUR,
      4 * HOUR,
      24 * HOUR,
      7 * 24 * HOUR,
    ]) {
      expect(alignPeriodStart(nowMs, periodMs)).toBe(
        Math.floor(nowMs / periodMs) * periodMs,
      );
    }
  });

  test("rejects a non-positive period and a negative now", () => {
    expect(() => alignPeriodStart(HOUR, 0)).toThrow(/periodMs/);
    expect(() => alignPeriodStart(-1, HOUR)).toThrow(/nowMs/);
  });
});

describe("deriveBucketingParams -- bin width comes from volatility, not from the window", () => {
  // A fixed tick count cannot size rows across instruments: 992 ticks is $9.92
  // on a 1-cent crypto tick but 248 points on a 25-cent ES tick, which is ~80
  // rows on BTC spot and a single row on ES. A volatility reading is the same
  // quantity on every instrument, so the ROW COUNT is what travels.
  test("sizes from the volatility reading, projected onto the session period", async () => {
    const params = await deriveBucketingParams({
      adapter: fakeAdapter({
        minPrice: 78732.22,
        maxPrice: 79071.12,
        tradeCount: 82739,
        available: true,
      }),
      tickSize: 0.01,
      fromTs: 0,
      toTs: HOUR,
      atrReading: { atr: 40.88, barIntervalMs: BAR_MS },
      atrSessionMs: FOUR_HOURS,
    });
    expect(params.sizing).toBe("atr");
    // Deliberately the EXACT quotient, not a tick- or grain-snapped value:
    // 40.88 x sqrt(240) / 75 = 8.4441..., and the bin is that number of price
    // units. A price width needs no common denominator with a tick size, and
    // snapping it to one is what used to collapse the multiplier's range.
    const expected = (40.88 * Math.sqrt(FOUR_HOURS / BAR_MS)) / 75;
    expect(params.rowWidth).toBeCloseTo(expected, 9);
    // Not a whole number of ticks, which is the point.
    expect(Number.isInteger(params.rowWidth / 0.01)).toBe(false);
  });

  test("an unclamped reading scales the width with the session length", async () => {
    // sqrt scaling, not linear: a 4x session spans 2x the distance, so the bin
    // is 2x as wide and the row count is unchanged. Asserted as a RATIO because
    // the width is now an unsnapped price quantity rather than a tick count.
    const oneHour = await deriveBucketingParams({
      adapter: fakeAdapter({
        minPrice: 0,
        maxPrice: 100,
        tradeCount: 5,
        available: true,
      }),
      tickSize: 0.25,
      fromTs: 0,
      toTs: HOUR,
      atrReading: { atr: 4, barIntervalMs: BAR_MS },
      atrSessionMs: HOUR,
    });
    const fourHours = await deriveBucketingParams({
      adapter: fakeAdapter({
        minPrice: 0,
        maxPrice: 100,
        tradeCount: 5,
        available: true,
      }),
      tickSize: 0.25,
      fromTs: 0,
      toTs: HOUR,
      atrReading: { atr: 4, barIntervalMs: BAR_MS },
      atrSessionMs: FOUR_HOURS,
    });
    expect(fourHours.rowWidth / oneHour.rowWidth).toBeCloseTo(2, 9);
  });

  test("an unclamped reading scales the width with the session length", async () => {
    // The clamp is calibrated on the reference span, so with no span supplied
    // a longer session gets a proportionally wider bin -- not a proportionally
    // larger row count.
    const oneHour = await deriveBucketingParams({
      adapter: fakeAdapter({
        minPrice: 0,
        maxPrice: 0,
        tradeCount: 0,
        available: true,
      }),
      tickSize: 0.01,
      fromTs: 0,
      toTs: HOUR,
      atrReading: { atr: 20, barIntervalMs: BAR_MS },
      atrSessionMs: HOUR,
    });
    const fourHours = await deriveBucketingParams({
      adapter: fakeAdapter({
        minPrice: 0,
        maxPrice: 0,
        tradeCount: 0,
        available: true,
      }),
      tickSize: 0.01,
      fromTs: 0,
      toTs: HOUR,
      atrReading: { atr: 20, barIntervalMs: BAR_MS },
      atrSessionMs: FOUR_HOURS,
    });
    // sqrt(4) = 2, so the 4h bin is around twice the 1h bin (before the grain
    // snap, which can pull each to the nearest 32 ticks).
    expect(fourHours.rowWidth / oneHour.rowWidth).toBeGreaterThan(1.6);
    expect(fourHours.rowWidth / oneHour.rowWidth).toBeLessThan(2.4);
  });

  test("a reading works even when the window itself traded nothing", async () => {
    // A quiet window previously produced no profile at all, because the only
    // sizing input was the window's own range.
    const params = await deriveBucketingParams({
      adapter: fakeAdapter({
        minPrice: null,
        maxPrice: null,
        tradeCount: 0,
        available: true,
      }),
      tickSize: 0.01,
      fromTs: 0,
      toTs: HOUR,
      atrReading: { atr: 20, barIntervalMs: BAR_MS },
      atrSessionMs: FOUR_HOURS,
    });
    expect(params).not.toBeNull();
    expect(params.rowWidth).toBeGreaterThan(0);
    expect(params.tradeCount).toBe(0);
  });

  test("the clamp keeps a mis-scaled reading inside a usable row count", async () => {
    const params = await deriveBucketingParams({
      adapter: fakeAdapter({
        minPrice: 0,
        maxPrice: 700,
        tradeCount: 10,
        available: true,
      }),
      tickSize: 0.1,
      fromTs: 0,
      toTs: HOUR,
      // Absurdly small, so only the clamp prevents thousands of rows.
      atrReading: { atr: 0.0001, barIntervalMs: BAR_MS, referenceRange: 700 },
      atrSessionMs: FOUR_HOURS,
    });
    expect(700 / params.rowWidth).toBeLessThanOrEqual(MAX_ATR_ROW_COUNT + 1e-6);
    expect(700 / params.rowWidth).toBeGreaterThanOrEqual(
      MIN_ATR_ROW_COUNT - 1e-6,
    );
  });

  test("an ATR reference range replaces the window probe instead of adding to it", async () => {
    const readPriceRange = jest.fn(() => {
      throw new Error("the ATR reference range must be used instead");
    });
    const params = await deriveBucketingParams({
      adapter: { readPriceRange },
      tickSize: 0.1,
      fromTs: 0,
      toTs: HOUR,
      atrReading: { atr: 5, barIntervalMs: BAR_MS, referenceRange: 700 },
      atrSessionMs: FOUR_HOURS,
    });
    expect(readPriceRange).not.toHaveBeenCalled();
    expect(params.sizing).toBe("atr");
    expect(params.rowWidth).toBeGreaterThan(0);
  });

  test("falls back to the window's range when no reading is available", async () => {
    const params = await deriveBucketingParams({
      adapter: fakeAdapter({
        minPrice: 78732.22,
        maxPrice: 79071.12,
        tradeCount: 82739,
        available: true,
      }),
      tickSize: 0.01,
      fromTs: 0,
      toTs: HOUR,
    });
    expect(params.sizing).toBe("range");
    // 338.9 of range over 75 rows, in price, unsnapped.
    expect(params.rowWidth).toBeCloseTo(338.9 / 75, 9);
  });

  test("a fallback range still lands near the target row count", async () => {
    const params = await deriveBucketingParams({
      adapter: fakeAdapter({
        minPrice: 0,
        maxPrice: 20_000,
        tradeCount: 100,
        available: true,
      }),
      tickSize: 0.01,
      fromTs: 0,
      toTs: HOUR,
    });
    const rows = 20_000 / params.rowWidth;
    expect(Math.round(rows)).toBeCloseTo(75, -1);
    // The row width is no longer required to be a whole number of rollup grains.
    // That constraint belongs to the cache's queries, not to the live grid.
    expect(params.rowWidth).toBeGreaterThan(0);
  });

  test("a default request with no reading and an empty window has nothing to size from", async () => {
    expect(
      await deriveBucketingParams({
        adapter: fakeAdapter({
          minPrice: null,
          maxPrice: null,
          tradeCount: 0,
          available: true,
        }),
        tickSize: 0.01,
        fromTs: 0,
        toTs: HOUR,
      }),
    ).toBeNull();
  });

  test("a multiplier still needs a window to size from, since there is no absolute width any more", async () => {
    // The removed absolute override was the one input that needed no window at
    // all. A multiplier scales a DERIVED width, so an empty window with no
    // reading has nothing to scale and must resolve to null rather than invent
    // a width.
    const params = await deriveBucketingParams({
      adapter: fakeAdapter({
        minPrice: null,
        maxPrice: null,
        tradeCount: 0,
        available: true,
      }),
      tickSize: 1,
      fromTs: 0,
      toTs: HOUR,
      binSizeMultiplier: 2,
    });
    expect(params).toBeNull();
  });

  test("a larger multiplier produces a wider bin on the range-derived path", async () => {
    // A wide range on purpose: a display row floors at one rollup grain, so a
    // small range would clamp both multipliers to that floor and hide the
    // effect being tested.
    const range = fakeAdapter({
      minPrice: 0,
      maxPrice: 30_000,
      tradeCount: 10,
      available: true,
    });
    const fine = await deriveBucketingParams({
      adapter: range,
      tickSize: 1,
      fromTs: 0,
      toTs: HOUR,
      binSizeMultiplier: 0.5,
    });
    const coarse = await deriveBucketingParams({
      adapter: range,
      tickSize: 1,
      fromTs: 0,
      toTs: HOUR,
      binSizeMultiplier: 8,
    });
    expect(coarse.rowWidth).toBeGreaterThan(fine.rowWidth);
  });

  test("anchors every profile to an absolute price grid at 0 so buckets nest across windows", async () => {
    const params = await deriveBucketingParams({
      adapter: fakeAdapter({
        minPrice: 100,
        maxPrice: 200,
        tradeCount: 10,
        available: true,
      }),
      tickSize: 1,
      fromTs: 0,
      toTs: HOUR,
    });
    expect(params.originPrice).toBe(PROFILE_ORIGIN_PRICE);
    expect(PROFILE_ORIGIN_PRICE).toBe(0);
  });

  test("the bin is exactly the span over the row count -- no tick or grain quantisation", async () => {
    // The old invariant was "row width is an exact integer multiple of the tick
    // size", which forced every width through a tick count and then a grain
    // snap. That is what made the multiplier inert on coarse-tick instruments,
    // so the invariant is gone: the width is the plain quotient.
    for (const [tickSize, minPrice, maxPrice] of [
      [0.01, 78732.22, 79071.12],
      [0.25, 5000, 5100],
      [1, 10, 4000],
    ]) {
      const { rowWidth } = await deriveBucketingParams({
        adapter: fakeAdapter({
          minPrice,
          maxPrice,
          tradeCount: 5,
          available: true,
        }),
        tickSize,
        fromTs: 0,
        toTs: HOUR,
      });
      expect(rowWidth).toBeCloseTo((maxPrice - minPrice) / 75, 9);
      expect(rowWidth).toBeGreaterThan(0);
    }
  });

  test("the multiplier is independent of which window is being binned -- it only scales the derived width", async () => {
    // Both ranges are wide enough that neither result sits on the one-grain
    // floor, which would otherwise mask the difference.
    const opts = { tickSize: 1, fromTs: 0, toTs: HOUR, binSizeMultiplier: 4 };
    const wide = await deriveBucketingParams({
      adapter: fakeAdapter({
        minPrice: 0,
        maxPrice: 60_000,
        tradeCount: 5,
        available: true,
      }),
      ...opts,
    });
    const narrowRange = await deriveBucketingParams({
      adapter: fakeAdapter({
        minPrice: 0,
        maxPrice: 6_000,
        tradeCount: 5,
        available: true,
      }),
      ...opts,
    });
    // Each window is sized from its OWN range, then scaled by the same factor,
    // so the wider window still gets the wider bin.
    expect(wide.rowWidth).toBeGreaterThan(narrowRange.rowWidth);
  });

  test("a flat window (every trade at one price) still yields a usable row width, never zero", async () => {
    const { rowWidth } = await deriveBucketingParams({
      adapter: fakeAdapter({
        minPrice: 500,
        maxPrice: 500,
        tradeCount: 3,
        available: true,
      }),
      tickSize: 0.5,
      fromTs: 0,
      toTs: HOUR,
    });
    expect(rowWidth).toBeGreaterThan(0);
  });

  test("returns null rather than guessing when the window holds no trades or storage is unavailable", async () => {
    const empty = {
      minPrice: null,
      maxPrice: null,
      tradeCount: 0,
      available: true,
    };
    expect(
      await deriveBucketingParams({
        adapter: fakeAdapter(empty),
        tickSize: 1,
        fromTs: 0,
        toTs: HOUR,
      }),
    ).toBeNull();
    const down = {
      minPrice: null,
      maxPrice: null,
      tradeCount: 0,
      available: false,
    };
    expect(
      await deriveBucketingParams({
        adapter: fakeAdapter(down),
        tickSize: 1,
        fromTs: 0,
        toTs: HOUR,
      }),
    ).toBeNull();
  });

  test("rejects an adapter that cannot report a price range at all, instead of silently degrading", async () => {
    await expect(
      deriveBucketingParams({
        adapter: {},
        tickSize: 1,
        fromTs: 0,
        toTs: HOUR,
      }),
    ).rejects.toThrow(/readPriceRange/);
  });

  test("rejects invalid tick size, window, and bin-size multiplier inputs", async () => {
    const adapter = fakeAdapter({
      minPrice: 1,
      maxPrice: 2,
      tradeCount: 1,
      available: true,
    });
    await expect(
      deriveBucketingParams({ adapter, tickSize: 0, fromTs: 0, toTs: HOUR }),
    ).rejects.toThrow(/tickSize/);
    await expect(
      deriveBucketingParams({ adapter, tickSize: 1, fromTs: HOUR, toTs: 0 }),
    ).rejects.toThrow(/toTs/);
    // A multiplier scales a width, so zero and below are not representable, and
    // a fractional value is now LEGAL -- unlike the integer tick override it
    // replaced. Only the range is rejected. The floor is 0.02 (lowered from 0.1
    // on 2026-09-28), so 0.01 is still below it.
    for (const bad of [0, -1, 0.01, 11, NaN]) {
      await expect(
        deriveBucketingParams({
          adapter,
          tickSize: 1,
          fromTs: 0,
          toTs: HOUR,
          binSizeMultiplier: bad,
        }),
      ).rejects.toThrow(/binSizeMultiplier/);
    }
  });
});
