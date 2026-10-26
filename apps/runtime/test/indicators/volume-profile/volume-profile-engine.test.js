const {
  resolveRowWidth,
  resolveTicksPerRow,
  resolveAtrTicksPerRow,
  resolveAtrBinSizePrice,
  projectSessionSpan,
  createSession,
  seedSessionFromStorage,
  bucketIndexFor,
  applyTradeRow,
  computeProfile,
  smoothBuckets,
  pollOpenPeriod,
  finalizePeriod,
  rolloverPeriod,
  rescaleSessionToFit,
  MAX_PROFILE_BUCKETS,
  ROLLUP_GRAIN_TICKS,
  MIN_ATR_ROW_COUNT,
  MAX_ATR_ROW_COUNT,
  DEFAULT_TARGET_ROW_COUNT,
  MIN_BIN_SIZE_MULTIPLIER,
  MAX_BIN_SIZE_MULTIPLIER,
} = require("../../../src/indicators/volume-profile/volume-profile-engine");

const BAR_MS = 60_000;
const FOUR_HOURS = 4 * 60 * 60 * 1000;

function fakeAdapter({ trades } = {}) {
  const sorted = [...(trades ?? [])].sort(
    (a, b) => a.ts - b.ts || a.tradeId - b.tradeId,
  );
  return {
    readTradesSince(fromTs, toTs, cursor, limit) {
      const inRange = sorted.filter((row) => row.ts >= fromTs && row.ts < toTs);
      const afterCursor =
        cursor === null
          ? inRange
          : inRange.filter(
              (row) =>
                row.ts > cursor.ts ||
                (row.ts === cursor.ts && row.tradeId > cursor.id),
            );
      const page = afterCursor.slice(0, limit);
      const last = page.at(-1);
      return {
        rows: page,
        nextCursor: last ? { ts: last.ts, id: last.tradeId } : null,
        available: true,
      };
    },
    readVolumeProfile(fromTs, toTs, originPrice, rowWidth) {
      const inRange = sorted.filter((row) => row.ts >= fromTs && row.ts < toTs);
      const buckets = new Map();
      for (const row of inRange) {
        const bucket = Math.floor((row.price - originPrice) / rowWidth);
        const existing = buckets.get(bucket) ?? {
          volume: 0,
          buyVolume: 0,
          sellVolume: 0,
          tradeCount: 0,
        };
        existing.volume += row.size;
        if (row.side === "buy") existing.buyVolume += row.size;
        else if (row.side === "sell") existing.sellVolume += row.size;
        existing.tradeCount += 1;
        buckets.set(bucket, existing);
      }
      return {
        buckets: [...buckets.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([bucket, values]) => ({ bucket, ...values })),
        available: true,
      };
    },
  };
}

// Bin width now comes from volatility (an ATR over one-minute candles), with
// the window's own range as a fallback. A fixed tick count cannot work across
// instruments: 992 ticks is $9.92 on a 1-cent crypto tick but 248 points on a
// 25-cent ES tick, which is ~80 rows on BTC spot and a single row on ES.
describe("resolveRowWidth", () => {
  test("an already-resolved binSizeTicks is honoured exactly, for any tick size", () => {
    expect(resolveRowWidth({ tickSize: 0.25, binSizeTicks: 992 })).toBeCloseTo(
      248,
      9,
    );
    expect(resolveRowWidth({ tickSize: 0.01, binSizeTicks: 992 })).toBeCloseTo(
      9.92,
      9,
    );
    expect(resolveRowWidth({ tickSize: 1, binSizeTicks: 992 })).toBe(992);
    // Below one grain is still honoured: a resolved width is a literal.
    expect(resolveRowWidth({ tickSize: 1, binSizeTicks: 1 })).toBe(1);
  });

  test("a volatility-derived width wins over the window's own range, and is returned unsnapped", () => {
    // A price width derived from volatility is returned VERBATIM. It used to be
    // converted to ticks and snapped to the 32-tick grain (giving 9.60 here),
    // which quantised the caller's control onto a coarse grid.
    expect(
      resolveRowWidth({
        tickSize: 0.1,
        binSizePrice: 9.512,
        referenceRange: 702.65,
      }),
    ).toBe(9.512);
  });

  test("falls back to the window's range when no reading is available", () => {
    // 702.65 over 75 rows, as a plain quotient -- no tick, no grain.
    expect(
      resolveRowWidth({ tickSize: 0.1, referenceRange: 702.65 }),
    ).toBeCloseTo(702.65 / 75, 9);
  });

  test("a range-derived width is not floored at a rollup grain any more", () => {
    // The grain floor stays in the CACHE's own query path, where it belongs.
    // On the live grid a tiny span simply gives a tiny bin.
    expect(resolveRowWidth({ tickSize: 1, referenceRange: 1 })).toBeCloseTo(
      1 / 75,
      9,
    );
  });

  test("a default request with neither a reading nor a range has nothing to size from", () => {
    expect(() => resolveRowWidth({ tickSize: 1 })).toThrow(/referenceRange/);
    expect(() => resolveRowWidth({ tickSize: 1, referenceRange: 0 })).toThrow(
      /referenceRange/,
    );
  });

  test("rejects invalid inputs", () => {
    expect(() => resolveRowWidth({ tickSize: 0 })).toThrow(/tickSize/);
    expect(() =>
      resolveRowWidth({ tickSize: 1, referenceRange: 1, binSizeTicks: 0 }),
    ).toThrow(/binSizeTicks/);
    expect(() =>
      resolveRowWidth({ tickSize: 1, referenceRange: 1, binSizeTicks: -3 }),
    ).toThrow(/binSizeTicks/);
    expect(() =>
      resolveRowWidth({ tickSize: 1, referenceRange: 1, binSizeTicks: 2.5 }),
    ).toThrow(/binSizeTicks/);
    expect(() =>
      resolveRowWidth({ tickSize: 1, referenceRange: 1, binSizePrice: 0 }),
    ).toThrow(/binSizePrice/);
  });
});

// A random walk over n bars spans about one bar's range times sqrt(n). That
// square root is what lets a reading taken on one-minute bars size rows for a
// session many times longer than them.
describe("projectSessionSpan", () => {
  test("scales a bar range by the square root of the bar count", () => {
    // sqrt(240) = 15.49, so a 46.05 mean bar range projects ~713 over 4 hours --
    // against a real measured 4h span of 702.65 on BTC perp.
    const projected = projectSessionSpan({
      referenceAtr: 46.05,
      barIntervalMs: BAR_MS,
      sessionMs: FOUR_HOURS,
    });
    expect(projected).toBeCloseTo(713, 0);
    expect(Math.abs(projected - 702.65)).toBeLessThan(15);
  });

  test("a shorter session projects a proportionally shorter span", () => {
    const hour = projectSessionSpan({
      referenceAtr: 10,
      barIntervalMs: BAR_MS,
      sessionMs: 60 * 60 * 1000,
    });
    const fourHours = projectSessionSpan({
      referenceAtr: 10,
      barIntervalMs: BAR_MS,
      sessionMs: FOUR_HOURS,
    });
    expect(fourHours / hour).toBeCloseTo(2, 6);
  });

  test("rejects a non-positive reading, interval or session", () => {
    expect(() =>
      projectSessionSpan({
        referenceAtr: 0,
        barIntervalMs: BAR_MS,
        sessionMs: FOUR_HOURS,
      }),
    ).toThrow(/referenceAtr/);
    expect(() =>
      projectSessionSpan({
        referenceAtr: 1,
        barIntervalMs: 0,
        sessionMs: FOUR_HOURS,
      }),
    ).toThrow(/barIntervalMs/);
    expect(() =>
      projectSessionSpan({
        referenceAtr: 1,
        barIntervalMs: BAR_MS,
        sessionMs: 0,
      }),
    ).toThrow(/sessionMs/);
  });
});

describe("resolveAtrTicksPerRow", () => {
  test("projects the reading onto the session, then divides by the row count", () => {
    const ticks = resolveAtrTicksPerRow({
      tickSize: 0.1,
      referenceAtr: 46.05,
      barIntervalMs: BAR_MS,
      sessionMs: FOUR_HOURS,
    });
    // 46.05 x sqrt(240) = 713.2 over 75 rows = 9.51; on a 0.1 tick that is 95.1
    // ticks, snapped to 96 -- a 9.60 bin, and ~73 rows over a 702.65 session.
    expect(ticks).toBe(96);
    expect(ticks % ROLLUP_GRAIN_TICKS).toBe(0);
  });

  test("clamps a mis-scaled reading to a usable row count", () => {
    // An absurdly small reading would otherwise ask for thousands of rows.
    const tiny = resolveAtrTicksPerRow({
      tickSize: 0.1,
      referenceAtr: 0.0001,
      barIntervalMs: BAR_MS,
      sessionMs: FOUR_HOURS,
      referenceRange: 700,
    });
    expect(700 / (tiny * 0.1)).toBeLessThanOrEqual(MAX_ATR_ROW_COUNT + 1e-6);
    expect(tiny % ROLLUP_GRAIN_TICKS).toBe(0);

    // An absurdly large one would otherwise ask for a handful of rows.
    const huge = resolveAtrTicksPerRow({
      tickSize: 0.1,
      referenceAtr: 10_000,
      barIntervalMs: BAR_MS,
      sessionMs: FOUR_HOURS,
      referenceRange: 700,
    });
    // The grain snap runs AFTER the clamp and rounds UP, so the row CEILING
    // holds exactly while the row FLOOR is approximate to within one grain of
    // width. That asymmetry is deliberate: exceeding the row ceiling is the
    // pathological case the clamp exists for, and the live path does not use
    // this function at all.
    const rows = 700 / (huge * 0.1);
    const oneGrainOfRows = (rows * ROLLUP_GRAIN_TICKS) / huge;
    expect(rows).toBeGreaterThanOrEqual(
      MIN_ATR_ROW_COUNT - oneGrainOfRows - 1e-6,
    );
    expect(huge % ROLLUP_GRAIN_TICKS).toBe(0);
  });

  test("a reading that needs no clamping is left alone", () => {
    const declared = resolveAtrTicksPerRow({
      tickSize: 0.1,
      referenceAtr: 46.05,
      barIntervalMs: BAR_MS,
      sessionMs: FOUR_HOURS,
    });
    const withRange = resolveAtrTicksPerRow({
      tickSize: 0.1,
      referenceAtr: 46.05,
      barIntervalMs: BAR_MS,
      sessionMs: FOUR_HOURS,
      referenceRange: 700,
    });
    expect(withRange).toBe(declared);
  });

  test("rejects a nonsense clamp configuration", () => {
    expect(() =>
      resolveAtrTicksPerRow({
        tickSize: 0.1,
        referenceAtr: 1,
        barIntervalMs: BAR_MS,
        sessionMs: FOUR_HOURS,
        minRowCount: 100,
        maxRowCount: 10,
      }),
    ).toThrow(/maxRowCount/);
  });

  // Regression: the multiplier used to be inert on coarse-tick instruments. The
  // grain (32 ticks then) was at or above BOTH clamp bounds, so the clamp
  // collapsed to a constant and every multiplier from 0.1 to 10 resolved to the
  // same width -- on /ES that was 8.00 points for all of them, so the setting
  // did nothing at all. Lowering the grain to 8 is what gives the multiplier
  // room to act, and this pins that it actually does.
  test("the multiplier produces a CONTINUOUS range of widths, not one", () => {
    // /ES-shaped: 0.25 tick, 20 of 1-minute travel. No referenceRange, so the
    // clamp cannot be what limits the result -- this is the multiplier's own
    // reach, on the path the live chart actually uses.
    const es = {
      tickSize: 0.25,
      referenceAtr: 20,
      barIntervalMs: BAR_MS,
      sessionMs: FOUR_HOURS,
    };
    const widths = new Set();
    for (let m = 0.1; m <= 10.0001; m += 0.1) {
      widths.add(
        resolveAtrBinSizePrice({
          ...es,
          binSizeMultiplier: Math.round(m * 10) / 10,
        }),
      );
    }
    // Every one of the 100 steps is distinct: the control is linear in price,
    // with no tick count and no grain snap in the way. It used to collapse to a
    // single width across this entire range on exactly this instrument shape.
    expect(widths.size).toBe(100);

    const finest = resolveAtrBinSizePrice({ ...es, binSizeMultiplier: 0.1 });
    const baseline = resolveAtrBinSizePrice(es);
    expect(finest).toBeCloseTo(baseline / 10, 9);
    expect(baseline * 75).toBeCloseTo(20 * Math.sqrt(240), 9);
  });

  test("a wider multiplier never produces a NARROWER bin", () => {
    const es = {
      tickSize: 0.25,
      referenceAtr: 20,
      barIntervalMs: BAR_MS,
      sessionMs: FOUR_HOURS,
      referenceRange: 310,
    };
    let previous = 0;
    for (let m = 0.1; m <= 10.0001; m += 0.1) {
      const ticks = resolveAtrTicksPerRow({
        ...es,
        binSizeMultiplier: Math.round(m * 10) / 10,
      });
      expect(ticks).toBeGreaterThanOrEqual(previous);
      previous = ticks;
    }
  });
});

describe("resolveTicksPerRow", () => {
  test("snaps a volatility-derived price width onto the rollup grain", () => {
    // 9.512 / 0.1 = 95.1 ticks -> 96 after the snap.
    expect(resolveTicksPerRow({ tickSize: 0.1, binSizePrice: 9.512 })).toBe(96);
  });

  test("gives the exact tick count without dividing a price width back down", () => {
    // The cache query works in whole grains, so this has to be an integer even
    // where a price width would not divide cleanly by the tick.
    const ticks = resolveTicksPerRow({ tickSize: 0.01, binSizePrice: 4.48 });
    expect(Number.isSafeInteger(ticks)).toBe(true);
    expect(ticks % ROLLUP_GRAIN_TICKS).toBe(0);
    expect(ticks).toBe(448);
  });
});

describe("bucketIndexFor / applyTradeRow", () => {
  test("matches plain Math.floor bucketing", () => {
    const params = { originPrice: 100, rowWidth: 1 };
    expect(bucketIndexFor(100, params)).toBe(0);
    expect(bucketIndexFor(100.9999, params)).toBe(0);
    expect(bucketIndexFor(99.5, params)).toBe(-1);
    expect(bucketIndexFor(98.5, params)).toBe(-2);
  });

  test("buy/sell accumulate into the right bucket", () => {
    const buckets = new Map();
    const params = { originPrice: 100, rowWidth: 1 };
    applyTradeRow(buckets, { price: 100, size: 2, side: "buy" }, params);
    applyTradeRow(buckets, { price: 100.5, size: 3, side: "sell" }, params);
    expect(buckets.get(0)).toEqual({ volume: 5, buyVolume: 2, sellVolume: 3 });
  });

  test("a null (UNDEFINED-aggressor) side counts in volume only", () => {
    const buckets = new Map();
    const params = { originPrice: 100, rowWidth: 1 };
    applyTradeRow(buckets, { price: 100, size: 5, side: null }, params);
    expect(buckets.get(0)).toEqual({ volume: 5, buyVolume: 0, sellVolume: 0 });
  });

  test("rejects invalid inputs", () => {
    const buckets = new Map();
    const params = { originPrice: 100, rowWidth: 1 };
    expect(() =>
      applyTradeRow(buckets, { price: NaN, size: 1, side: "buy" }, params),
    ).toThrow(/price/);
    expect(() =>
      applyTradeRow(buckets, { price: 100, size: 0, side: "buy" }, params),
    ).toThrow(/size/);
    expect(() =>
      applyTradeRow(buckets, { price: 100, size: 1, side: "unknown" }, params),
    ).toThrow(/side/);
  });

  test("rejects a zero or invalid rowWidth/originPrice instead of silently producing a NaN bucket", () => {
    const buckets = new Map();
    expect(() =>
      applyTradeRow(
        buckets,
        { price: 100, size: 1, side: "buy" },
        { originPrice: 100, rowWidth: 0 },
      ),
    ).toThrow(/rowWidth/);
    expect(() =>
      applyTradeRow(
        buckets,
        { price: 100, size: 1, side: "buy" },
        { originPrice: 100, rowWidth: -1 },
      ),
    ).toThrow(/rowWidth/);
    expect(() =>
      applyTradeRow(
        buckets,
        { price: 100, size: 1, side: "buy" },
        { originPrice: NaN, rowWidth: 1 },
      ),
    ).toThrow(/originPrice/);
    expect(() =>
      bucketIndexFor(100, { originPrice: 100, rowWidth: 0 }),
    ).toThrow(/rowWidth/);
    expect(() =>
      bucketIndexFor(100, { originPrice: NaN, rowWidth: 1 }),
    ).toThrow(/originPrice/);
  });
});

describe("computeProfile", () => {
  function buckets(entries) {
    return new Map(
      entries.map(([index, volume, buyVolume = 0, sellVolume = 0]) => [
        index,
        { volume, buyVolume, sellVolume },
      ]),
    );
  }

  test("POC is the max-volume bucket", () => {
    const result = computeProfile(
      buckets([
        [0, 10],
        [1, 20],
        [2, 5],
      ]),
    );
    expect(result.pocIndex).toBe(1);
  });

  // The indices are derived from the SMOOTHED map, so a tie only reaches the
  // tie-break when it survives smoothing. This profile smooths to
  // 6.25 / 7.5 / 7.5 / 7.5 / 6.25 -- a three-way tie on the plateau, whose
  // middle bin is also the one nearest the profile's mid-range, so the
  // documented rule picks index 2.
  test("POC tie breaks toward the bucket closest to the profile's mid-range", () => {
    const result = computeProfile(
      buckets([
        [0, 5],
        [1, 10],
        [2, 5],
        [3, 10],
        [4, 5],
      ]),
    );
    expect(result.buckets.get(1).volume).toBeCloseTo(
      result.buckets.get(2).volume,
      9,
    );
    expect(result.buckets.get(2).volume).toBeCloseTo(
      result.buckets.get(3).volume,
      9,
    );
    expect(result.pocIndex).toBe(2);
  });

  test("a fully-tied POC (equal volume, equal distance from mid-range) resolves deterministically regardless of insertion order", () => {
    const forward = new Map([
      [0, { volume: 5, buyVolume: 0, sellVolume: 0 }],
      [1, { volume: 10, buyVolume: 0, sellVolume: 0 }],
      [2, { volume: 5, buyVolume: 0, sellVolume: 0 }],
      [3, { volume: 10, buyVolume: 0, sellVolume: 0 }],
      [4, { volume: 5, buyVolume: 0, sellVolume: 0 }],
    ]);
    const reversed = new Map([
      [3, { volume: 10, buyVolume: 0, sellVolume: 0 }],
      [0, { volume: 5, buyVolume: 0, sellVolume: 0 }],
      [1, { volume: 10, buyVolume: 0, sellVolume: 0 }],
      [2, { volume: 5, buyVolume: 0, sellVolume: 0 }],
      [4, { volume: 5, buyVolume: 0, sellVolume: 0 }],
    ]);
    expect(computeProfile(forward).pocIndex).toBe(
      computeProfile(reversed).pocIndex,
    );
  });

  test("does not crash on a very large bucket count (a misconfigured/tiny rowWidth should degrade, not throw)", () => {
    const huge = new Map();
    for (let i = 0; i < 250_000; i += 1)
      huge.set(i, {
        volume: i === 100_000 ? 5 : 1,
        buyVolume: 0,
        sellVolume: 0,
      });
    const result = computeProfile(huge, { valueAreaPct: 0.01 });
    expect(result.pocIndex).toBe(100_000);
  });

  test("defaults to a 70% Value Area target when valueAreaPct is not given", () => {
    const uniform = buckets(Array.from({ length: 11 }, (_, i) => [i, 10]));
    const result = computeProfile(uniform);
    expect(result.vaHigh).toBe(10);
    expect(result.vaLow).toBe(3);
  });

  // A2.20 / L1L2-V2-054. P4.09 states the Value Area repeats "until cumulative
  // Value Area volume reaches 70% of total". It did not, on any profile with a
  // gap in it: expandValueArea read a missing neighbour as -1 and stopped when
  // both sides were missing, so an EMPTY ROW was treated as "stop" rather than
  // "zero volume, keep going". VAH and VAL are numbers on the user's screen,
  // so this was a wrong displayed value measured against its own definition.
  //
  // Gaps are reachable in normal use: row width targets ~75 rows across a
  // 15-minute reference range, and one fast move skips a row easily.
  test("expands across an empty row instead of stopping at it -- an empty row is zero volume, not the end", () => {
    const gapped = new Map([
      [-1, { volume: 5, buyVolume: 0, sellVolume: 0 }],
      [0, { volume: 100, buyVolume: 0, sellVolume: 0 }],
      [2, { volume: 200, buyVolume: 0, sellVolume: 0 }],
    ]);

    const result = computeProfile(gapped, { valueAreaPct: 0.7 });

    // POC is index 2. Index 1 is empty; the 100-volume cluster at index 0 sits
    // beyond it and was previously excluded entirely, leaving VA at 65.6%.
    expect(result.pocIndex).toBe(2);
    expect(result.vaLow).toBeLessThanOrEqual(0);
    expect(result.vaHigh).toBe(2);

    let covered = 0;
    for (const [index, bucket] of gapped) {
      if (index >= result.vaLow && index <= result.vaHigh)
        covered += bucket.volume;
    }
    expect(covered / result.totalVolume).toBeGreaterThanOrEqual(0.7);
  });

  // The documented target is only meaningful if it always holds. Expansion can
  // run out of buckets, but running out means the Value Area covers every
  // bucket, which is 100% -- so there is no profile shape that legitimately
  // finishes below target.
  test.each([
    [
      "a gap on the low side",
      [
        [-4, 50],
        [-1, 5],
        [0, 100],
        [2, 200],
      ],
    ],
    [
      "gaps on both sides",
      [
        [-6, 40],
        [-3, 30],
        [0, 250],
        [4, 60],
        [9, 45],
      ],
    ],
    [
      "a single isolated bucket far above",
      [
        [0, 300],
        [25, 10],
      ],
    ],
    [
      "a contiguous control",
      [
        [0, 10],
        [1, 20],
        [2, 30],
        [3, 20],
        [4, 10],
      ],
    ],
  ])("reaches the documented 70%% target -- %s", async (_label, entries) => {
    const profile = new Map(
      entries.map(([i, volume]) => [
        i,
        { volume, buyVolume: 0, sellVolume: 0 },
      ]),
    );

    const result = computeProfile(profile, { valueAreaPct: 0.7 });

    let covered = 0;
    for (const [index, bucket] of profile) {
      if (index >= result.vaLow && index <= result.vaHigh)
        covered += bucket.volume;
    }
    expect(covered / result.totalVolume).toBeGreaterThanOrEqual(0.7);
  });

  test("Value Area expands one bucket at a time toward the higher-volume side (above)", () => {
    const result = computeProfile(
      buckets([
        [0, 10],
        [1, 20],
        [2, 5],
      ]),
      { valueAreaPct: 0.7 },
    );
    expect(result.vaHigh).toBe(1);
    expect(result.vaLow).toBe(0);
  });

  // Smoothing moves the Value Area too: the spread pulls the two heavy bins in
  // the middle toward each other, so index 3 now holds enough to be taken in
  // ahead of the low side's next bin.
  test("Value Area expansion correctly picks the below side when it has more volume", () => {
    const result = computeProfile(
      buckets([
        [0, 5],
        [1, 8],
        [2, 20],
        [3, 3],
        [4, 2],
      ]),
      { valueAreaPct: 0.7 },
    );
    expect(result.vaHigh).toBe(3);
    expect(result.vaLow).toBe(1);
  });

  // A single-print flag needs a bin under 15% of POC *after* smoothing, which
  // is a stricter bar than before: a lone quiet bin wedged between busy ones
  // now inherits a quarter of each neighbour's volume and is lifted clear of the
  // threshold. That is the intended trade -- single prints are a raw-shape
  // reading, and the drawn profile no longer has a one-bin hole to point at.
  test("single-print buckets are flagged under 15% of POC volume", () => {
    const result = computeProfile(
      buckets([
        [0, 100],
        [1, 10],
        [2, 50],
      ]),
    );
    expect(result.singlePrintBuckets).toEqual([]);
  });

  test("still flags a quiet bin that smoothing leaves below the threshold", () => {
    // 100 / 1 / 100: the quiet bin smooths to 50.5 against a 75.5 POC, so it
    // sits at 67% of POC -- nowhere near the 15% threshold, and correctly not
    // flagged. A quiet bin BETWEEN busy neighbours always inherits at least
    // half the POC's volume, so smoothing removes the one-bin-hole shape the
    // flag used to point at. Only a quiet CLUSTER can still be a single print.
    const between = computeProfile(
      buckets([
        [0, 100],
        [1, 1],
        [2, 100],
      ]),
    );
    expect(between.buckets.get(1).volume).toBeCloseTo(50.5, 9);
    expect(between.singlePrintBuckets).toEqual([]);

    // A quiet cluster far from the peak keeps its low volume, because the only
    // bins feeding it are its own small neighbours.
    const cluster = computeProfile(
      buckets([
        [0, 100],
        [1, 100],
        [10, 1],
        [11, 1],
      ]),
    );
    expect(cluster.singlePrintBuckets).toEqual([10, 11]);
  });

  test("an empty profile returns a safe null default", () => {
    const result = computeProfile(new Map());
    expect(result).toMatchObject({
      pocIndex: null,
      vaHigh: null,
      vaLow: null,
      totalVolume: 0,
      singlePrintBuckets: [],
    });
  });

  test("a single-bucket profile has that bucket as both POC and the whole Value Area", () => {
    const result = computeProfile(buckets([[0, 10]]));
    expect(result).toMatchObject({
      pocIndex: 0,
      vaHigh: 0,
      vaLow: 0,
      totalVolume: 10,
    });
  });

  test("rejects an invalid valueAreaPct", () => {
    expect(() =>
      computeProfile(buckets([[0, 1]]), { valueAreaPct: 0 }),
    ).toThrow(/valueAreaPct/);
    expect(() =>
      computeProfile(buckets([[0, 1]]), { valueAreaPct: 1.5 }),
    ).toThrow(/valueAreaPct/);
  });

  // The frame builders take their line prices from these indices but their bar
  // widths from the returned buckets, so the two must describe the same shape.
  test("returns the smoothed buckets its own indices were derived from", () => {
    const result = computeProfile(
      buckets([
        [0, 10],
        [1, 20],
        [2, 5],
      ]),
    );
    expect(result.buckets.get(1).volume).toBeCloseTo(
      0.25 * 10 + 0.5 * 20 + 0.25 * 5,
      9,
    );
  });

  test("does not mutate the caller's bucket map", () => {
    const raw = buckets([
      [0, 10],
      [1, 20],
      [2, 5],
    ]);
    computeProfile(raw);
    expect(raw.get(0).volume).toBe(10);
    expect(raw.get(1).volume).toBe(20);
    expect(raw.get(2).volume).toBe(5);
  });

  // A live session's map is re-read and re-smoothed on every poll, so smoothing
  // twice must not compound. Deriving from the raw map each time is what makes
  // that true; this pins it.
  test("is idempotent through the raw map: repeated derivation gives the same shape", () => {
    const raw = buckets([
      [0, 10],
      [1, 20],
      [2, 5],
    ]);
    const first = computeProfile(raw).buckets;
    const second = computeProfile(raw).buckets;
    expect([...second.entries()]).toEqual([...first.entries()]);
  });
});

describe("smoothBuckets", () => {
  function buckets(entries) {
    return new Map(
      entries.map(([index, volume, buyVolume = 0, sellVolume = 0]) => [
        index,
        { volume, buyVolume, sellVolume },
      ]),
    );
  }

  test("gives a quarter of each bin to each existing neighbour and keeps the rest", () => {
    const smoothed = smoothBuckets(
      buckets([
        [0, 10],
        [1, 20],
        [2, 5],
      ]),
    );

    // Edge bins have only one neighbour, so they keep 0.75 rather than 0.5 --
    // the share with nowhere to go is folded back in, not lost.
    expect(smoothed.get(0).volume).toBeCloseTo(0.75 * 10 + 0.25 * 20, 9);
    expect(smoothed.get(1).volume).toBeCloseTo(
      0.25 * 10 + 0.5 * 20 + 0.25 * 5,
      9,
    );
    expect(smoothed.get(2).volume).toBeCloseTo(0.25 * 20 + 0.75 * 5, 9);
  });

  test("conserves total volume exactly, edges and interior alike", () => {
    for (const entries of [
      [
        [0, 10],
        [1, 20],
        [2, 5],
      ],
      [[0, 100]],
      [
        [0, 5],
        [1, 8],
        [2, 20],
        [3, 3],
        [4, 2],
      ],
      [
        [-4, 50],
        [-1, 5],
        [0, 100],
        [2, 200],
      ],
    ]) {
      const raw = buckets(entries);
      const total = [...raw.values()].reduce(
        (sum, bucket) => sum + bucket.volume,
        0,
      );
      const smoothedTotal = [...smoothBuckets(raw).values()].reduce(
        (sum, bucket) => sum + bucket.volume,
        0,
      );
      expect(smoothedTotal).toBeCloseTo(total, 9);
    }
  });

  test("never adds a bucket, so the key set -- and the MAX_PROFILE_BUCKETS ceiling -- is unchanged", () => {
    const raw = buckets([
      [0, 10],
      [1, 20],
      [2, 5],
    ]);
    const smoothed = smoothBuckets(raw);
    expect([...smoothed.keys()].sort((a, b) => a - b)).toEqual(
      [...raw.keys()].sort((a, b) => a - b),
    );
  });

  // A gap is a genuine absence of traded volume, not a zero bin: materialising
  // one would widen the histogram past the traded range and print volume in a
  // price band nothing traded at.
  test("leaves a gap as a gap, and nothing crosses it", () => {
    const smoothed = smoothBuckets(
      buckets([
        [0, 100],
        [2, 100],
      ]),
    );

    expect(smoothed.has(1)).toBe(false);
    // The missing bin is not a transfer partner, so each wall has no neighbour
    // on that side, keeps its whole volume, and nothing crosses the hole.
    expect(smoothed.get(0).volume).toBeCloseTo(100, 9);
    expect(smoothed.get(2).volume).toBeCloseTo(100, 9);
  });

  test("preserves buy_volume + sell_volume === volume per bin, which Delta Profile reads (P4.10 AC)", () => {
    const raw = buckets([
      [0, 100, 60, 40],
      [1, 10, 3, 7],
      [2, 50, 50, 0],
    ]);
    for (const bucket of smoothBuckets(raw).values()) {
      expect(bucket.buyVolume + bucket.sellVolume).toBeCloseTo(
        bucket.volume,
        9,
      );
    }
  });

  test("preserves the null-side remainder: buy and sell stay zero where they started zero", () => {
    // An UNDEFINED-aggressor trade counts in volume only (see applyTradeRow),
    // and smoothing must not invent a side for it.
    const smoothed = smoothBuckets(
      buckets([
        [0, 10],
        [1, 20],
        [2, 5],
      ]),
    );
    for (const bucket of smoothed.values()) {
      expect(bucket.buyVolume).toBe(0);
      expect(bucket.sellVolume).toBe(0);
    }
  });

  test("does not mutate the map it was given", () => {
    const raw = buckets([
      [0, 10],
      [1, 20],
      [2, 5],
    ]);
    smoothBuckets(raw);
    expect(raw.get(0).volume).toBe(10);
    expect(raw.get(1).volume).toBe(20);
    expect(raw.get(2).volume).toBe(5);
  });

  test("returns an empty map for an empty profile", () => {
    expect(smoothBuckets(new Map()).size).toBe(0);
  });

  test("leaves a single isolated bucket exactly as it was", () => {
    const smoothed = smoothBuckets(buckets([[7, 10]]));
    expect(smoothed.size).toBe(1);
    expect(smoothed.get(7).volume).toBe(10);
  });

  // The whole point of the derivation: a one-bin spike is spread onto its
  // neighbours, so the drawn profile has no isolated needle.
  test("lowers a lone spike and raises the bins around it", () => {
    const raw = buckets([
      [0, 1],
      [1, 100],
      [2, 1],
    ]);
    const smoothed = smoothBuckets(raw);

    expect(smoothed.get(1).volume).toBeCloseTo(
      0.5 * 100 + 0.25 * 1 + 0.25 * 1,
      9,
    );
    expect(smoothed.get(1).volume).toBeLessThanOrEqual(raw.get(1).volume);
    expect(smoothed.get(0).volume).toBeCloseTo(0.75 * 1 + 0.25 * 100, 9);
    expect(smoothed.get(0).volume).toBeGreaterThan(raw.get(0).volume);
  });
});

describe("pollOpenPeriod", () => {
  test("cursor-polled result equals a fresh readVolumeProfile aggregation over the same trades", async () => {
    const trades = Array.from({ length: 50 }, (_, i) => ({
      ts: 1000 + i,
      tradeId: i,
      price: 100 + (i % 7) * 0.5,
      size: 1 + (i % 3),
      side: i % 2 === 0 ? "buy" : "sell",
    }));
    const adapter = fakeAdapter({ trades });
    const session = createSession({
      periodStartTs: 1000,
      originPrice: 100,
      rowWidth: 1,
    });
    await pollOpenPeriod(session, adapter, 2000, { pageLimit: 7 });

    const { buckets: aggregated } = adapter.readVolumeProfile(
      1000,
      2000,
      100,
      1,
    );
    const aggregatedMap = new Map(
      aggregated.map((row) => [
        row.bucket,
        {
          volume: row.volume,
          buyVolume: row.buyVolume,
          sellVolume: row.sellVolume,
        },
      ]),
    );

    expect(session.buckets).toEqual(aggregatedMap);
  });

  test("a backlog exceeding one page drains fully within maxPagesPerTick", async () => {
    const trades = Array.from({ length: 23 }, (_, i) => ({
      ts: 1000 + i,
      tradeId: i,
      price: 100,
      size: 1,
      side: "buy",
    }));
    const adapter = fakeAdapter({ trades });
    const session = createSession({
      periodStartTs: 1000,
      originPrice: 100,
      rowWidth: 1,
    });
    const { rowsApplied, pagesFetched } = await pollOpenPeriod(
      session,
      adapter,
      2000,
      { pageLimit: 5, maxPagesPerTick: 10 },
    );

    expect(rowsApplied).toBe(23);
    expect(pagesFetched).toBe(5);
    expect(session.buckets.get(0).volume).toBe(23);
  });

  test("a backlog exceeding maxPagesPerTick is picked up cleanly on the next tick -- no lost or duplicated rows", async () => {
    const trades = Array.from({ length: 25 }, (_, i) => ({
      ts: 1000 + i,
      tradeId: i,
      price: 100,
      size: 1,
      side: "buy",
    }));
    const adapter = fakeAdapter({ trades });
    const session = createSession({
      periodStartTs: 1000,
      originPrice: 100,
      rowWidth: 1,
    });

    const first = await pollOpenPeriod(session, adapter, 2000, {
      pageLimit: 5,
      maxPagesPerTick: 2,
    });
    expect(first.rowsApplied).toBe(10);

    const second = await pollOpenPeriod(session, adapter, 2000, {
      pageLimit: 5,
      maxPagesPerTick: 10,
    });
    expect(second.rowsApplied).toBe(15);

    expect(session.buckets.get(0).volume).toBe(25);
  });

  test("an empty page leaves the cursor unchanged rather than resetting it", async () => {
    const trades = [{ ts: 1000, tradeId: 1, price: 100, size: 1, side: "buy" }];
    const adapter = fakeAdapter({ trades });
    const session = createSession({
      periodStartTs: 1000,
      originPrice: 100,
      rowWidth: 1,
    });
    await pollOpenPeriod(session, adapter, 1500);
    const cursorAfterFirstPoll = session.pollCursor;

    await pollOpenPeriod(session, adapter, 2000);
    expect(session.pollCursor).toEqual(cursorAfterFirstPoll);
  });

  test("stops after one page when the adapter returns a null cursor even though the page exactly filled the limit -- never re-fetches or double-counts", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      ts: 1000 + i,
      tradeId: i,
      price: 100,
      size: 1,
      side: "buy",
    }));
    const adapter = {
      readTradesSince: () => ({ rows, nextCursor: null, available: true }),
    };
    const session = createSession({
      periodStartTs: 1000,
      originPrice: 100,
      rowWidth: 1,
    });

    const { rowsApplied, pagesFetched } = await pollOpenPeriod(
      session,
      adapter,
      2000,
      { pageLimit: 5, maxPagesPerTick: 10 },
    );

    expect(pagesFetched).toBe(1);
    expect(rowsApplied).toBe(5);
    expect(session.buckets.get(0).volume).toBe(5);
  });

  test("rejects a nowMs before periodStartTs", async () => {
    const session = createSession({
      periodStartTs: 1000,
      originPrice: 100,
      rowWidth: 1,
    });
    await expect(
      pollOpenPeriod(session, fakeAdapter({ trades: [] }), 500),
    ).rejects.toThrow(/nowMs/);
  });

  test("a malformed row anywhere in a page leaves buckets and the cursor untouched -- no partial application", async () => {
    const rows = [
      { ts: 1000, tradeId: 1, price: 100, size: 1, side: "buy" },
      { ts: 1001, tradeId: 2, price: 100, size: 1, side: "buy" },
      { ts: 1002, tradeId: 3, price: 100, size: -1, side: "buy" },
    ];
    const adapter = {
      readTradesSince: () => ({
        rows,
        nextCursor: { ts: 1002, id: 3 },
        available: true,
      }),
    };
    const session = createSession({
      periodStartTs: 1000,
      originPrice: 100,
      rowWidth: 1,
    });

    await expect(pollOpenPeriod(session, adapter, 2000)).rejects.toThrow(
      /size/,
    );
    expect(session.buckets.size).toBe(0);
    expect(session.pollCursor).toBeNull();

    await expect(pollOpenPeriod(session, adapter, 2000)).rejects.toThrow(
      /size/,
    );
    expect(session.buckets.size).toBe(0);
  });
});

describe("finalizePeriod", () => {
  test("replaces JS-accumulated buckets with the authoritative SQL aggregation", async () => {
    const trades = [
      { ts: 1000, tradeId: 1, price: 100, size: 1, side: "buy" },
      { ts: 1001, tradeId: 2, price: 100, size: 1, side: "buy" },
    ];
    const adapter = fakeAdapter({ trades });
    const session = createSession({
      periodStartTs: 1000,
      originPrice: 100,
      rowWidth: 1,
    });
    session.buckets.set(0, { volume: 999, buyVolume: 999, sellVolume: 0 });

    await finalizePeriod(session, adapter, 2000);

    expect(session.buckets.get(0)).toEqual({
      volume: 2,
      buyVolume: 2,
      sellVolume: 0,
    });
    expect(session.periodEndTs).toBe(2000);
  });
});

describe("rolloverPeriod", () => {
  test("finalizes the current session and opens a fresh, independently-sized one", async () => {
    const trades = [{ ts: 1000, tradeId: 1, price: 100, size: 1, side: "buy" }];
    const adapter = fakeAdapter({ trades });
    const session = createSession({
      periodStartTs: 1000,
      originPrice: 100,
      rowWidth: 1,
    });

    const { closedSession, nextSession } = await rolloverPeriod(
      session,
      adapter,
      2000,
      {
        tickSize: 0.25,
        referenceRange: 100,
        originPrice: 200,
      },
    );

    expect(closedSession.periodEndTs).toBe(2000);
    expect(nextSession.periodStartTs).toBe(2000);
    expect(nextSession.periodEndTs).toBeNull();
    expect(nextSession.originPrice).toBe(200);
    expect(nextSession.buckets.size).toBe(0);
    expect(nextSession.rowWidth).not.toBe(session.rowWidth);
  });
});

// Closure-audit regression suite. A session's row width is resolved once,
// from a short reference range, but the period then runs for an hour. When
// price travels far beyond that reference range the bucket count grows past
// the wire cap and the frame builder throws -- which every caller catches and
// logs, leaving the chart frozen on its last good frame while still looking
// live. Reproduced directly before this suite was written: a $250 BTC move
// (tickSize 0.01, reference range 50) produced 373 buckets against a cap of 300.
describe("rescaleSessionToFit -- keeping a live session inside the wire cap", () => {
  function sessionWith(
    bucketCount,
    { rowWidth = 1, originPrice = 64000, startIndex = 0 } = {},
  ) {
    const buckets = new Map();
    for (let i = 0; i < bucketCount; i += 1) {
      buckets.set(startIndex + i, { volume: 2, buyVolume: 1, sellVolume: 1 });
    }
    return {
      periodStartTs: 1000,
      periodEndTs: null,
      rowWidth,
      originPrice,
      buckets,
    };
  }

  function totalVolume(session) {
    return [...session.buckets.values()].reduce(
      (sum, bucket) => sum + bucket.volume,
      0,
    );
  }

  test("merges a session that overflows the wire cap down under it", () => {
    // Must exceed the cap to exercise a merge. Uses the cap itself rather than
    // a literal, so raising it cannot silently stop testing the merge path.
    const session = sessionWith(MAX_PROFILE_BUCKETS + 1);
    expect(session.buckets.size).toBeGreaterThan(MAX_PROFILE_BUCKETS);
    rescaleSessionToFit(session);
    expect(session.buckets.size).toBeLessThanOrEqual(MAX_PROFILE_BUCKETS);
  });

  test("conserves total volume exactly across a merge -- no trade is lost or double counted", () => {
    const session = sessionWith(373);
    const before = totalVolume(session);
    rescaleSessionToFit(session);
    expect(totalVolume(session)).toBe(before);
  });

  test("conserves buy and sell volume separately, not just the total", () => {
    const session = sessionWith(373);
    const buyBefore = [...session.buckets.values()].reduce(
      (s, b) => s + b.buyVolume,
      0,
    );
    const sellBefore = [...session.buckets.values()].reduce(
      (s, b) => s + b.sellVolume,
      0,
    );
    rescaleSessionToFit(session);
    expect(
      [...session.buckets.values()].reduce((s, b) => s + b.buyVolume, 0),
    ).toBe(buyBefore);
    expect(
      [...session.buckets.values()].reduce((s, b) => s + b.sellVolume, 0),
    ).toBe(sellBefore);
  });

  test("doubles rowWidth once per merge pass so bucket index still maps to the same price grid", () => {
    const session = sessionWith(MAX_PROFILE_BUCKETS + 1, { rowWidth: 0.67 });
    const lowestPriceBefore =
      session.originPrice +
      Math.min(...session.buckets.keys()) * session.rowWidth;
    rescaleSessionToFit(session);
    expect(session.rowWidth).toBe(1.34);
    const lowestPriceAfter =
      session.originPrice +
      Math.min(...session.buckets.keys()) * session.rowWidth;
    expect(lowestPriceAfter).toBe(lowestPriceBefore);
  });

  test("leaves a session already inside the cap completely untouched", () => {
    const session = sessionWith(10, { rowWidth: 0.25 });
    const passes = rescaleSessionToFit(session);
    expect(passes).toBe(0);
    expect(session.buckets.size).toBe(10);
    expect(session.rowWidth).toBe(0.25);
  });

  test("merges buckets below the origin without collapsing the two sides of the origin together", () => {
    // Must exceed the cap to trigger a merge pass. Spanning the origin means
    // the pairs are (-2,-1) and (0,1); a truncating merge would instead pull
    // -1, 0 and 1 into one bucket, mixing volume that traded below the origin
    // into a bucket whose nominal price range starts at the origin.
    const span = MAX_PROFILE_BUCKETS + 2;
    const session = sessionWith(span, { startIndex: -Math.ceil(span / 2) });
    session.buckets.set(-1, { volume: 7, buyVolume: 7, sellVolume: 0 });
    session.buckets.set(0, { volume: 11, buyVolume: 0, sellVolume: 11 });
    const before = totalVolume(session);

    rescaleSessionToFit(session);

    expect(session.buckets.size).toBeLessThanOrEqual(MAX_PROFILE_BUCKETS);
    expect(totalVolume(session)).toBe(before);
    // old -2 + old -1 stays strictly below the origin
    expect(session.buckets.get(-1).volume).toBe(9);
    // old 0 + old 1 stays at/above the origin
    expect(session.buckets.get(0).volume).toBe(13);
  });

  test("pollOpenPeriod keeps its own session inside the cap after applying a wide page of trades", async () => {
    // Enough distinct prices to blow the cap with the fixed 0.67 bin width.
    const session = createSession({
      periodStartTs: 0,
      originPrice: 64000,
      rowWidth: 0.67,
    });
    const rows = [];
    const span = MAX_PROFILE_BUCKETS * 0.67 + 10;
    for (let p = 64000; p < 64000 + span; p += 0.5) {
      rows.push({ ts: 10, tradeId: `t-${p}`, price: p, size: 1, side: "buy" });
    }
    const adapter = {
      readTradesSince: () => ({
        rows,
        nextCursor: { ts: 10, id: 1 },
        available: true,
      }),
      readVolumeProfile: () => ({ buckets: [], available: true }),
    };
    const result = await pollOpenPeriod(session, adapter, 1000, {
      pageLimit: rows.length + 1,
    });
    expect(result.rowsApplied).toBe(rows.length);
    expect(session.buckets.size).toBeLessThanOrEqual(MAX_PROFILE_BUCKETS);
    expect(result.rescalePasses).toBeGreaterThan(0);
  });

  test("finalizePeriod keeps a closed period inside the cap when storage returns more buckets than the wire allows", async () => {
    const session = createSession({
      periodStartTs: 0,
      originPrice: 64000,
      rowWidth: 1,
    });
    const readerBuckets = [];
    for (let i = 0; i < 500; i += 1) {
      readerBuckets.push({ bucket: i, volume: 2, buyVolume: 1, sellVolume: 1 });
    }
    const adapter = {
      readTradesSince: () => ({ rows: [], nextCursor: null, available: true }),
      readVolumeProfile: () => ({ buckets: readerBuckets, available: true }),
    };
    await finalizePeriod(session, adapter, 5000);
    expect(session.buckets.size).toBeLessThanOrEqual(MAX_PROFILE_BUCKETS);
    expect(
      [...session.buckets.values()].reduce((s, b) => s + b.volume, 0),
    ).toBe(1000);
  });

  test("rejects a non-positive bucket budget rather than looping forever", () => {
    expect(() => rescaleSessionToFit(sessionWith(10), 0)).toThrow(/maxBuckets/);
    expect(() => rescaleSessionToFit(sessionWith(10), -1)).toThrow(
      /maxBuckets/,
    );
  });
});

// P4.10 Delta Profile's own first acceptance criterion: buy_volume +
// sell_volume must reconcile exactly to each bucket's total volume, for
// every bucket, at every stage of the pipeline a ProfileFrame can come
// from. This is guaranteed by construction in applyTradeRow (each trade's
// size is added to volume and to exactly one of buyVolume/sellVolume) --
// tested directly here so a future change to that function cannot quietly
// break it, and verified separately against real production data.
describe("buy_volume + sell_volume reconciles exactly to volume, per bucket (P4.10 AC)", () => {
  test("holds for a live session built incrementally via applyTradeRow across many mixed-side trades", () => {
    const session = createSession({
      periodStartTs: 0,
      originPrice: 0,
      rowWidth: 1,
    });
    for (let i = 0; i < 500; i += 1) {
      const price = (i * 7) % 23;
      const side = i % 3 === 0 ? "sell" : "buy";
      applyTradeRow(
        session.buckets,
        { price, size: 1 + (i % 4) * 0.25, side },
        session,
      );
    }
    expect(session.buckets.size).toBeGreaterThan(1);
    for (const bucket of session.buckets.values()) {
      expect(bucket.buyVolume + bucket.sellVolume).toBeCloseTo(
        bucket.volume,
        9,
      );
    }
  });

  test("null-side (undefined-aggressor) trades count toward volume but neither buy nor sell", () => {
    const session = createSession({
      periodStartTs: 0,
      originPrice: 0,
      rowWidth: 10,
    });
    applyTradeRow(session.buckets, { price: 5, size: 3, side: null }, session);
    const bucket = session.buckets.get(0);
    expect(bucket.volume).toBe(3);
    expect(bucket.buyVolume).toBe(0);
    expect(bucket.sellVolume).toBe(0);
  });

  test("holds after computeProfile's own POC/Value-Area derivation, which must not mutate bucket volumes", () => {
    const session = createSession({
      periodStartTs: 0,
      originPrice: 0,
      rowWidth: 1,
    });
    for (let i = 0; i < 200; i += 1) {
      applyTradeRow(
        session.buckets,
        {
          price: i % 11,
          size: 1 + (i % 3),
          side: i % 2 === 0 ? "buy" : "sell",
        },
        session,
      );
    }
    computeProfile(session.buckets);
    for (const bucket of session.buckets.values()) {
      expect(bucket.buyVolume + bucket.sellVolume).toBeCloseTo(
        bucket.volume,
        9,
      );
    }
  });
});

describe("binSizeMultiplier -- the user's control over the automatic size", () => {
  // The multiplier scales the VOLATILITY-derived bin size. It replaced an
  // absolute "Row size override (ticks)" because a tick is not a unit of price
  // movement: no fixed tick count sizes rows sensibly on both a 1-cent crypto
  // and a 25-cent ES contract.
  const ES = {
    tickSize: 0.25,
    referenceAtr: 20,
    barIntervalMs: 60_000,
    sessionMs: 4 * 60 * 60 * 1000,
  };

  test("1 is the default and matches omitting the argument entirely", () => {
    expect(resolveAtrTicksPerRow({ ...ES, binSizeMultiplier: 1 })).toBe(
      resolveAtrTicksPerRow(ES),
    );
  });

  test("a larger multiplier means a COARSER bin: wider rows and fewer of them", () => {
    // A large session span so the resolved width sits well above the one-grain
    // floor; at the floor both sides would collapse to 32 and look identical.
    const long = {
      tickSize: 1,
      referenceAtr: 100,
      barIntervalMs: 60_000,
      sessionMs: 24 * 60 * 60 * 1000,
    };
    const fine = resolveAtrTicksPerRow({ ...long, binSizeMultiplier: 0.25 });
    const coarse = resolveAtrTicksPerRow({ ...long, binSizeMultiplier: 8 });
    expect(coarse).toBeGreaterThan(fine);
  });

  test("scales the bin itself, so it is meaningful on a fine tick too", () => {
    // The resolved width is snapped to whole rollup grains, so an exact multiple
    // is not guaranteed -- but the DIRECTION must hold on both sides of 1.
    const crypto = {
      tickSize: 0.01,
      referenceAtr: 20,
      barIntervalMs: 60_000,
      sessionMs: 4 * 60 * 60 * 1000,
    };
    const base = resolveAtrTicksPerRow(crypto);
    expect(
      resolveAtrTicksPerRow({ ...crypto, binSizeMultiplier: 2 }),
    ).toBeGreaterThan(base);
    expect(
      resolveAtrTicksPerRow({ ...crypto, binSizeMultiplier: 0.5 }),
    ).toBeLessThan(base);
  });

  test("rejects a zero, negative or out-of-range multiplier rather than producing a zero-width bin", () => {
    for (const bad of [0, -1, 0.01, 11, NaN, Infinity]) {
      expect(() =>
        resolveAtrTicksPerRow({ ...ES, binSizeMultiplier: bad }),
      ).toThrow(/binSizeMultiplier/);
    }
  });

  test("the floor reaches a finer width than the one it replaced", () => {
    // 2026-09-28: the floor was lowered 0.1 -> 0.02. With no referenceRange the
    // clamp is out of the way, so this measures the multiplier's own reach.
    const atFloor = resolveAtrBinSizePrice({
      ...ES,
      binSizeMultiplier: MIN_BIN_SIZE_MULTIPLIER,
    });
    const atOldFloor = resolveAtrBinSizePrice({
      ...ES,
      binSizeMultiplier: 0.1,
    });
    expect(atFloor).toBeLessThan(atOldFloor);
    expect(atOldFloor / atFloor).toBeCloseTo(0.1 / MIN_BIN_SIZE_MULTIPLIER, 9);
  });
});

describe("the multiplier floor and the bucket ceiling move together", () => {
  // A finer floor only helps if the row ceiling it implies still fits under the
  // wire cap -- otherwise rescaleSessionToFit merges the extra rows back before
  // the profile is ever sent, and the finer bin is invisible to the client.
  test("the row ceiling implied by the floor fits under MAX_PROFILE_BUCKETS", () => {
    expect(MAX_ATR_ROW_COUNT).toBe(
      DEFAULT_TARGET_ROW_COUNT / MIN_BIN_SIZE_MULTIPLIER,
    );
    expect(MAX_PROFILE_BUCKETS).toBeGreaterThanOrEqual(MAX_ATR_ROW_COUNT);
    expect(MIN_ATR_ROW_COUNT).toBe(
      DEFAULT_TARGET_ROW_COUNT / MAX_BIN_SIZE_MULTIPLIER,
    );
  });

  test("the lowered floor sits ABOVE the pre-change ceiling -- so raising it was not cosmetic", () => {
    // Guards against lowering the floor again without raising the ceiling: at a
    // floor of 0.02 the row ceiling is 3750, well above the old wire cap of 1000.
    expect(DEFAULT_TARGET_ROW_COUNT / MIN_BIN_SIZE_MULTIPLIER).toBeGreaterThan(
      1000,
    );
    expect(MAX_PROFILE_BUCKETS).toBeGreaterThan(1000);
  });

  test("a full-span profile at the floor still fits the wire cap", () => {
    // /ES-shaped: 0.25 tick, 20 of 1-minute travel projected onto 4 hours.
    const es = {
      tickSize: 0.25,
      referenceAtr: 20,
      barIntervalMs: 60_000,
      sessionMs: FOUR_HOURS,
    };
    const referenceRange = 700;
    const width = resolveAtrBinSizePrice({
      ...es,
      referenceRange,
      binSizeMultiplier: MIN_BIN_SIZE_MULTIPLIER,
    });
    expect(referenceRange / width).toBeLessThanOrEqual(
      MAX_PROFILE_BUCKETS + 1e-6,
    );
  });
});

describe("resolveRowWidth -- the range fallback scales with the multiplier too", () => {
  // The fallback path (no volatility reading) must honour the same control, or
  // an instrument with thin candle history would silently ignore the setting.
  //
  // The range is deliberately large: a display row floors at one rollup grain
  // (32 ticks), so a small range would collapse both sides of the comparison
  // onto that floor and the multiplier would look inert when it is not.
  test("a larger multiplier produces a wider range-derived row", () => {
    const fine = resolveRowWidth({
      tickSize: 1,
      referenceRange: 30_000,
      targetRowCount: 75 / 0.5,
    });
    const coarse = resolveRowWidth({
      tickSize: 1,
      referenceRange: 30_000,
      targetRowCount: 75 / 4,
    });
    expect(coarse).toBeGreaterThan(fine);
    expect(fine).toBeGreaterThan(ROLLUP_GRAIN_TICKS);
  });

  test("the default range-derived width targets about 75 rows", () => {
    const rowWidth = resolveRowWidth({ tickSize: 0.25, referenceRange: 2500 });
    expect(Math.round(2500 / rowWidth)).toBeGreaterThan(70);
    expect(Math.round(2500 / rowWidth)).toBeLessThan(80);
    // The width is a plain quotient now, so the row count is EXACTLY 75.
    expect(2500 / rowWidth).toBeCloseTo(75, 9);
  });
});

// A2.21 / L1L2-V2-056. The off-thread seed is only useful if the value it
// produces is actually consumed. seedSessionFromStorage accepts a pre-fetched
// read so warm-up can hand it the worker's result instead of hitting SQLite on
// the relay's event loop.
describe("seedSessionFromStorage accepts a pre-fetched read", () => {
  function session() {
    return createSession({
      periodStartTs: 1_000,
      originPrice: 100,
      rowWidth: 1,
    });
  }

  test("uses the pre-fetched buckets and never touches the adapter", async () => {
    let adapterCalls = 0;
    const adapter = {
      readVolumeProfile() {
        adapterCalls += 1;
        return { buckets: [], available: true };
      },
    };
    const target = session();

    const seeded = await seedSessionFromStorage(target, adapter, 61_000, {
      buckets: [{ bucket: 3, volume: 9, buyVolume: 5, sellVolume: 4 }],
      available: true,
    });

    expect(seeded).toBe(true);
    expect(adapterCalls).toBe(0);
    expect(target.buckets.get(3)).toEqual({
      volume: 9,
      buyVolume: 5,
      sellVolume: 4,
    });
  });

  test("falls back to the adapter when nothing was pre-fetched, so the sync path is unchanged", async () => {
    let adapterCalls = 0;
    const adapter = {
      readVolumeProfile() {
        adapterCalls += 1;
        return {
          buckets: [{ bucket: 1, volume: 2, buyVolume: 1, sellVolume: 1 }],
          available: true,
        };
      },
    };
    const target = session();

    expect(await seedSessionFromStorage(target, adapter, 61_000)).toBe(true);
    expect(adapterCalls).toBe(1);
    expect(target.buckets.get(1)).toEqual({
      volume: 2,
      buyVolume: 1,
      sellVolume: 1,
    });
  });

  test("an unavailable pre-fetch does not silently fall through to a synchronous read", async () => {
    let adapterCalls = 0;
    const adapter = {
      readVolumeProfile() {
        adapterCalls += 1;
        return { buckets: [], available: true };
      },
    };

    expect(
      await seedSessionFromStorage(session(), adapter, 61_000, {
        buckets: [],
        available: false,
      }),
    ).toBe(false);
    expect(adapterCalls).toBe(0);
  });
});
