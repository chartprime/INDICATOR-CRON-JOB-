const {
  createVolumeProfileAtrReference,
  resolveTicksPerRowFromReading,
  trueRangeAverage,
  BAR_INTERVAL_MS,
  MIN_BARS_FOR_ATR,
} = require("../../../src/indicators/volume-profile/volume-profile-atr");
const {
  ROLLUP_GRAIN_TICKS,
} = require("../../../src/indicators/volume-profile/volume-profile-engine");

const FOUR_HOURS = 4 * 60 * 60 * 1000;

function barsFrom(ranges, startTs = 1_700_000_000_000) {
  return ranges.map((span, index) => {
    const open = 100;
    return {
      ts_open: startTs + index * BAR_INTERVAL_MS,
      open,
      high: open + span,
      low: open,
      close: open + span / 2,
    };
  });
}

function readerFor(ranges) {
  return { rows: barsFrom(ranges), available: true };
}

describe("trueRangeAverage", () => {
  test("averages high-low across the bars", () => {
    const measured = trueRangeAverage(barsFrom([1, 2, 3]));
    expect(measured.barCount).toBe(3);
    expect(measured.atr).toBeCloseTo(2, 9);
  });

  test("never widens a bar whose range already exceeds the gap", () => {
    // Each bar opens twice as far from the previous close as its own range is
    // wide, so the plain high-low wins and the average is the bar ranges.
    const measured = trueRangeAverage(barsFrom([40, 50, 60, 50, 50]));
    expect(measured.atr).toBeCloseTo(50, 9);
  });

  test("widens a bar's range to the gap from the previous close", () => {
    // The second bar opens far above the first close, so its true range is the
    // gap, not its own high-low.
    const rows = [
      { open: 100, high: 101, low: 100, close: 100.5 },
      { open: 110, high: 111, low: 110, close: 110.5 },
    ];
    const measured = trueRangeAverage(rows);
    // First bar contributes 1; the second contributes 111 - 100.5 = 10.5.
    expect(measured.atr).toBeCloseTo((1 + 10.5) / 2, 9);
  });

  test("skips a malformed row rather than poisoning the average", () => {
    const rows = [
      { open: 100, high: 101, low: 100, close: 100.5 },
      { open: 100, high: null, low: 100, close: 100.5 },
      { open: 100, high: 103, low: 100, close: 101 },
    ];
    const measured = trueRangeAverage(rows);
    expect(measured.barCount).toBe(2);
    expect(Number.isFinite(measured.atr)).toBe(true);
  });

  test("returns null when nothing is measurable", () => {
    expect(trueRangeAverage([])).toBeNull();
    expect(trueRangeAverage(null)).toBeNull();
    expect(trueRangeAverage([{ high: null, low: null }])).toBeNull();
  });
});

describe("createVolumeProfileAtrReference", () => {
  test("measures the reading through the supplied candle reader", async () => {
    const atr = createVolumeProfileAtrReference();
    const reading = await atr.getReading("BTC-USDT", {
      readCandles: async (options) => {
        expect(options.intervalMs).toBe(BAR_INTERVAL_MS);
        expect(options.windowMs).toBe(24 * 60 * 60 * 1000);
        return readerFor([40, 50, 60, 50, 50]);
      },
    });
    expect(reading.atr).toBeCloseTo(50, 9);
    expect(reading.barIntervalMs).toBe(BAR_INTERVAL_MS);
  });

  test("caches the reading instead of re-reading candles on every call", async () => {
    let reads = 0;
    const atr = createVolumeProfileAtrReference();
    const readCandles = async () => {
      reads += 1;
      return readerFor([40, 50, 60, 50, 50]);
    };
    await atr.getReading("BTC-USDT", { readCandles });
    await atr.getReading("BTC-USDT", { readCandles });
    await atr.getReading("BTC-USDT", { readCandles });
    expect(reads).toBe(1);

    atr.invalidate("BTC-USDT");
    await atr.getReading("BTC-USDT", { readCandles });
    expect(reads).toBe(2);
  });

  test("keeps the previous reading when a later read fails", async () => {
    const atr = createVolumeProfileAtrReference({ cacheTtlMs: 1 });
    await atr.getReading("BTC-USDT", {
      readCandles: async () => readerFor([40, 50, 60, 50, 50]),
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const reading = await atr.getReading("BTC-USDT", {
      readCandles: async () => {
        throw new Error("storage down");
      },
    });
    // A transient failure must not drop the instrument back to a different
    // sizing rule and shift every bin.
    expect(reading.atr).toBeCloseTo(50, 9);
  });

  test("returns null when there is too little history to measure", async () => {
    const atr = createVolumeProfileAtrReference();
    expect(
      await atr.getReading("BTC-USDT", {
        readCandles: async () => readerFor([40, 50]),
      }),
    ).toBeNull();
    expect(
      await atr.getReading("BTC-USDT", {
        readCandles: async () => ({ rows: [], available: false }),
      }),
    ).toBeNull();
    // Exactly one bar short of the minimum, to pin the boundary.
    expect(
      await atr.getReading("BTC-USDT", {
        readCandles: async () =>
          readerFor(Array.from({ length: MIN_BARS_FOR_ATR - 1 }, () => 50)),
      }),
    ).toBeNull();
    expect(
      await atr.getReading("BTC-USDT", {
        readCandles: async () =>
          readerFor(Array.from({ length: MIN_BARS_FOR_ATR }, () => 50)),
      }),
    ).not.toBeNull();
  });

  test("keeps the candle reading when only the reference range read fails", async () => {
    const atr = createVolumeProfileAtrReference();
    const reading = await atr.getReading("BTC-USDT", {
      readCandles: async () => readerFor([40, 50, 60, 50, 50]),
      readPriceRange: async () => {
        throw new Error("range storage down");
      },
    });
    // The two reads are independent; a failed span must not discard a good ATR.
    expect(reading.atr).toBeCloseTo(50, 9);
    expect(reading.referenceRange).toBeNull();
  });

  test("carries the reference window's span for the clamp", async () => {
    const atr = createVolumeProfileAtrReference();
    const reading = await atr.getReading("BTC-USDT", {
      readCandles: async () => readerFor([40, 50, 60, 50, 50]),
      readPriceRange: async () => ({
        minPrice: 100,
        maxPrice: 800,
        tradeCount: 10,
        available: true,
      }),
    });
    expect(reading.referenceRange).toBeCloseTo(700, 9);
  });

  test("anchors the reference window to the last CLOSED bar, not to the call instant", async () => {
    // Regression: the window used to slide with the exact millisecond of the
    // call, so every re-read returned a slightly different average -- hence a
    // slightly different bin width -- which rebuilt the zones and made them
    // flicker while the user panned. Two calls inside the same bar must ask for
    // an identical window even though the clock moved.
    const base = 1_800_000_000_000; // deliberately mid-bar
    const seen = [];
    // Advanced past the cache TTL but NOT past the next bar boundary, so the
    // only thing that could change the window is the clock drift.
    let nowMs = base;
    const atr = createVolumeProfileAtrReference({
      cacheTtlMs: 1,
      nowFn: () => nowMs,
    });
    const readCandles = async (options) => {
      seen.push(options.nowMs);
      return readerFor([40, 50, 60, 50, 50]);
    };
    await atr.getReading("BTC-USDT", { readCandles });
    nowMs = base + 30_000; // half a bar later, still the same bar
    await atr.getReading("BTC-USDT", { readCandles });

    expect(seen).toHaveLength(2);
    // Both reads land on the same bar boundary, and it is the one at or before
    // `now` -- never the still-forming bar itself.
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0] % BAR_INTERVAL_MS).toBe(0);
    expect(seen[0]).toBeLessThanOrEqual(base);
    expect(base - seen[0]).toBeLessThan(BAR_INTERVAL_MS);
  });

  test("rejects an empty instrument key and a missing reader", async () => {
    const atr = createVolumeProfileAtrReference();
    await expect(
      atr.getReading("", { readCandles: async () => readerFor([1]) }),
    ).rejects.toThrow(/instrument/);
    await expect(atr.getReading("BTC-USDT", {})).rejects.toThrow(/readCandles/);
  });
});

// The point of volatility-scaled sizing: the ROW COUNT is what carries across
// instruments, not the tick count. Each row below uses that instrument's real
// tick size and a one-minute ATR measured from the live capture, and asserts the
// 4-hour profile lands in a readable band.
describe("default bin count per instrument (4h session, target 75 rows)", () => {
  const CATALOG = [
    { label: "BTC spot", tickSize: 0.01, atr: 40.88 },
    { label: "BTC perp", tickSize: 0.1, atr: 46.05 },
    { label: "ETH spot", tickSize: 0.01, atr: 1.515 },
    { label: "ETH perp", tickSize: 0.01, atr: 1.62 },
  ];

  for (const { label, tickSize, atr } of CATALOG) {
    test(`${label} renders a sane bin count`, () => {
      const ticks = resolveTicksPerRowFromReading({
        reading: { atr, barIntervalMs: BAR_INTERVAL_MS },
        tickSize,
        sessionMs: FOUR_HOURS,
      });
      const rowWidth = ticks * tickSize;

      expect(ticks % ROLLUP_GRAIN_TICKS).toBe(0);
      expect(ticks).toBeGreaterThanOrEqual(ROLLUP_GRAIN_TICKS);

      // The projected session span is what the profile is bucketed against.
      const impliedRows = Math.round(
        (atr * Math.sqrt(FOUR_HOURS / BAR_INTERVAL_MS)) / rowWidth,
      );
      expect(impliedRows).toBeGreaterThanOrEqual(20);
      expect(impliedRows).toBeLessThanOrEqual(150);
      // And it should land near the 75-row target, not merely inside the band.
      expect(impliedRows).toBeGreaterThanOrEqual(50);
      expect(impliedRows).toBeLessThanOrEqual(110);
    });
  }

  test("a 10x tick-size difference does not produce a 10x row-count difference", () => {
    // BTC spot and BTC perp are the same market with ticks 10x apart. A fixed
    // tick count gave them bins 10x apart; volatility scaling must not.
    const sessionMs = FOUR_HOURS;
    const rowWidthFor = (tickSize, atr) =>
      resolveTicksPerRowFromReading({
        reading: { atr, barIntervalMs: BAR_INTERVAL_MS },
        tickSize,
        sessionMs,
      }) * tickSize;
    const spotRows =
      (40.88 * Math.sqrt(sessionMs / BAR_INTERVAL_MS)) /
      rowWidthFor(0.01, 40.88);
    const perpRows =
      (46.05 * Math.sqrt(sessionMs / BAR_INTERVAL_MS)) /
      rowWidthFor(0.1, 46.05);
    const ratio = Math.max(spotRows, perpRows) / Math.min(spotRows, perpRows);
    expect(ratio).toBeLessThan(1.5);
  });
});

describe("resolveTicksPerRowFromReading", () => {
  test("returns null without a usable reading, so the caller can fall back", () => {
    expect(
      resolveTicksPerRowFromReading({
        reading: null,
        tickSize: 0.1,
        sessionMs: FOUR_HOURS,
      }),
    ).toBeNull();
    expect(
      resolveTicksPerRowFromReading({
        reading: { atr: 0, barIntervalMs: BAR_INTERVAL_MS },
        tickSize: 0.1,
        sessionMs: FOUR_HOURS,
      }),
    ).toBeNull();
    expect(
      resolveTicksPerRowFromReading({
        reading: { atr: 1, barIntervalMs: BAR_INTERVAL_MS },
        tickSize: 0.1,
        sessionMs: 0,
      }),
    ).toBeNull();
  });
});
