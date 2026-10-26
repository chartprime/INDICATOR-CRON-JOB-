import { describe, it, expect } from "vitest";
import type { DeltaSource } from "../../live-delta-profile/candleDeltaSource";
import type {
  DeltaProfilePiece,
  DeltaProfileRow,
} from "../../live-delta-profile/deltaProfileStore";
import {
  calculateTickDeltaProfileBins,
  smoothTickProfileBins,
} from "../volumeDeltaProfileTick";
import { collectTickFlow } from "../volumeDeltaProfileTickSource";
import type { TickFlowLevel } from "../volumeDeltaProfileTickSource";

/** A source holding these rows, complete unless a test says otherwise. */
function source(
  rows: DeltaProfileRow[],
  overrides: Partial<DeltaSource> = {},
): DeltaSource {
  return {
    rowWidth: 1,
    version: 1,
    lastIndex: null,
    recent: [],
    issue: null,
    complete: true,
    pieces: [],
    rows: () => rows,
    ...overrides,
  };
}

function piece(from: number, to: number): DeltaProfilePiece {
  return { from, to, volume: 0 };
}

describe("collectTickFlow", () => {
  it("reads the source's rows as price levels", () => {
    const flow = collectTickFlow(
      source([
        { price: 100, buy: 3, sell: 1 },
        { price: 101, buy: 2, sell: 4 },
      ]),
    );

    expect(flow.levels).toEqual([
      { row: 100, buy: 3, sell: 1 },
      { row: 101, buy: 2, sell: 4 },
    ]);
  });

  it("keeps a row that traded on one side only", () => {
    const flow = collectTickFlow(source([{ price: 100, buy: 0, sell: 7 }]));

    expect(flow.levels).toEqual([{ row: 100, buy: 0, sell: 7 }]);
  });

  it("drops a row with no volume on either side", () => {
    const flow = collectTickFlow(
      source([
        { price: 100, buy: 0, sell: 0 },
        { price: 101, buy: 4, sell: 0 },
      ]),
    );

    expect(flow.levels).toEqual([{ row: 101, buy: 4, sell: 0 }]);
  });

  it("puts the row on the source's own grid, whatever width that is", () => {
    const flow = collectTickFlow(
      source([{ price: 2.5, buy: 9, sell: 0 }], { rowWidth: 0.5 }),
    );

    expect(flow.levels).toEqual([{ row: 5, buy: 9, sell: 0 }]);
  });

  it("reports nothing uncovered while the source holds its whole window", () => {
    expect(collectTickFlow(source([])).coveredFromMs).toBeNull();
  });

  it("reports where an incomplete source's data begins", () => {
    // The host answers a store newest first, so early on the profile holds only
    // the newest stretch of its window: the oldest piece in is where it starts.
    const flow = collectTickFlow(
      source([{ price: 100, buy: 1, sell: 0 }], {
        complete: false,
        pieces: [piece(9_000, 11_000), piece(8_000, 9_000), piece(11_000, 13_000)],
      }),
    );

    expect(flow.coveredFromMs).toBe(8_000);
  });

  it("reports nothing while an incomplete source holds no piece yet", () => {
    const flow = collectTickFlow(
      source([], { complete: false, pieces: [] }),
    );

    expect(flow.levels).toEqual([]);
    expect(flow.coveredFromMs).toBeNull();
  });
});

describe("calculateTickDeltaProfileBins", () => {
  const levels: TickFlowLevel[] = [
    { row: 5, buy: 10, sell: 2 },
    { row: 25, buy: 4, sell: 6 },
  ];

  it("bins each row's price (row * rowWidth) into the price domain", () => {
    const { bins, bucketHeight } = calculateTickDeltaProfileBins(
      levels,
      1,
      0,
      100,
      10,
    );

    expect(bucketHeight).toBe(10);
    expect(bins).toHaveLength(10);
    expect(bins[0]).toMatchObject({
      price: 5,
      buyVolume: 10,
      sellVolume: 2,
      totalVolume: 12,
      delta: 8,
    });
    expect(bins[2]).toMatchObject({
      price: 25,
      buyVolume: 4,
      sellVolume: 6,
      totalVolume: 10,
      delta: -2,
    });
    // Untouched buckets stay empty.
    expect(bins[1].totalVolume).toBe(0);
  });

  it("drops rows outside the price domain", () => {
    const { bins } = calculateTickDeltaProfileBins(
      [...levels, { row: 500, buy: 1, sell: 1 }],
      1,
      0,
      100,
      10,
    );

    const total = bins.reduce((sum, bin) => sum + bin.totalVolume, 0);
    expect(total).toBe(22);
  });

  it("scales with rowWidth", () => {
    const { bins } = calculateTickDeltaProfileBins(
      [{ row: 5, buy: 10, sell: 0 }],
      0.5,
      0,
      10,
      10,
    );

    // price = 5 * 0.5 = 2.5 -> bucket 2 of ten 1-wide buckets.
    expect(bins[2].totalVolume).toBe(10);
  });

  it("makes each bucket one whole source row once the count asked for would slice a row thinner", () => {
    // Three $10 rows asked for as 50 rows, over a $100 domain: 50 buckets would
    // be $2 each, thinner than the $10 the data actually knows, so the profile
    // answers with the domain's ten whole rows instead.
    const { bins, bucketHeight } = calculateTickDeltaProfileBins(
      [
        { row: 1, buy: 1, sell: 0 },
        { row: 2, buy: 1, sell: 0 },
        { row: 3, buy: 1, sell: 0 },
      ],
      10, // one price row spans $10
      0,
      100,
      50, // five times finer than the 10 rows the price range holds
    );

    expect(bucketHeight).toBe(10);
    expect(bins).toHaveLength(10);
    expect(bins.map((bin) => bin.totalVolume)).toEqual([
      0, 1, 1, 1, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it("draws one source row as one bucket holding all of its volume, not a flat fill over thinner ones", () => {
    // One $10 row with 40 bought, asked for as 8 rows over those $10: the data
    // only knows the row, so it reads 40 once rather than 5 eight times.
    const { bins, bucketHeight } = calculateTickDeltaProfileBins(
      [{ row: 1, buy: 40, sell: 0 }],
      10,
      10,
      20,
      8,
    );

    expect(bucketHeight).toBe(10);
    expect(bins).toHaveLength(1);
    expect(bins[0].price).toBe(15);
    expect(bins[0].totalVolume).toBe(40);
    expect(bins[0].buyVolume).toBe(40);
  });

  it("puts whole-row buckets on the source's own row grid when the domain starts between rows", () => {
    const { bins } = calculateTickDeltaProfileBins(
      [
        { row: 1, buy: 3, sell: 0 },
        { row: 3, buy: 0, sell: 5 },
      ],
      10,
      12,
      38,
      20,
    );

    expect(bins.map((bin) => bin.price)).toEqual([15, 25, 35]);
    expect(bins.map((bin) => bin.totalVolume)).toEqual([3, 0, 5]);
  });

  it("answers with the trader's count while the range holds room, and with the rows in view once zoomed in past one row per bucket", () => {
    // The same $10 rows and row width, at five price ranges: the count is the
    // trader's wherever a bucket can still be a whole row, and the domain's own
    // row count below that, which is what makes zooming change how many bins a
    // profile has.
    const looking = [
      { min: 0, max: 1_000_000, asked: 20, rows: 20, height: 50_000 },
      { min: 0, max: 1_000, asked: 20, rows: 20, height: 50 },
      { min: 0, max: 200, asked: 20, rows: 20, height: 10 },
      { min: 0, max: 150, asked: 20, rows: 15, height: 10 },
      { min: 0, max: 38, asked: 20, rows: 4, height: 10 },
    ] as const;

    for (const { min, max, asked, rows, height } of looking) {
      const { bins, bucketHeight } = calculateTickDeltaProfileBins(
        [{ row: 1, buy: 1, sell: 1 }],
        10,
        min,
        max,
        asked,
      );

      expect(bins).toHaveLength(rows);
      expect(bucketHeight).toBeCloseTo(height, 9);
    }
  });

  it("answers with exactly the count it was asked for when the count is fixed, whatever the domain", () => {
    // Fixed rows: the count is the trader's and nothing else, so zooming (a
    // narrower price domain) or a finer instrument row changes the bucket height,
    // never the number of rows, even where a bucket is a slice of a source row.
    const domains = [
      [12, 38, 20],
      [100, 100.5, 700],
      [0, 1_000_000, 20],
      [50, 51, 1_500],
    ] as const;

    for (const [min, max, asked] of domains) {
      const { bins, bucketHeight } = calculateTickDeltaProfileBins(
        [{ row: 1, buy: 1, sell: 1 }],
        10,
        min,
        max,
        asked,
        true,
      );

      expect(bins).toHaveLength(asked);
      expect(bucketHeight).toBeCloseTo((max - min) / asked, 9);
      // The buckets tile the domain: centred, no gap and no overhang.
      expect(bins[0].price).toBeCloseTo(min + bucketHeight / 2, 9);
      expect(bins[asked - 1].price).toBeCloseTo(max - bucketHeight / 2, 9);
    }
  });

  it("shares a source row over the buckets it reaches when the count is fixed", () => {
    // One $10 row with 40 bought, asked for as 8 rows over those $10: fixed, the
    // row's band is the whole domain, so each of the eight buckets takes an
    // eighth of its volume rather than the row showing up as one bar.
    const { bins, bucketHeight } = calculateTickDeltaProfileBins(
      [{ row: 1, buy: 40, sell: 0 }],
      10,
      10,
      20,
      8,
      true,
    );

    expect(bucketHeight).toBe(1.25);
    expect(bins).toHaveLength(8);
    expect(bins.map((bin) => bin.totalVolume)).toEqual([
      5, 5, 5, 5, 5, 5, 5, 5,
    ]);
    expect(bins[0].buyVolume).toBe(5);
    expect(bins.reduce((sum, bin) => sum + bin.totalVolume, 0)).toBe(40);
  });

  it("keeps the requested count when buckets are coarser than a row, sharing a straddling row by overlap", () => {
    const { bins, bucketHeight } = calculateTickDeltaProfileBins(
      [{ row: 1, buy: 9, sell: 3 }],
      3, // the row covers prices [3, 6)
      0,
      100,
      20, // 5-wide buckets: the row straddles the 5 boundary
    );

    expect(bucketHeight).toBe(5);
    expect(bins).toHaveLength(20);
    expect(bins[0].totalVolume).toBeCloseTo(8, 10);
    expect(bins[1].totalVolume).toBeCloseTo(4, 10);
    expect(bins[0].buyVolume).toBeCloseTo(6, 10);
    expect(bins[1].sellVolume).toBeCloseTo(1, 10);
  });

  it("returns no bins for empty input or a degenerate range", () => {
    expect(calculateTickDeltaProfileBins([], 1, 0, 100, 10)).toEqual({
      bins: [],
      bucketHeight: 0,
    });
    expect(calculateTickDeltaProfileBins(levels, 1, 50, 50, 10)).toEqual({
      bins: [],
      bucketHeight: 0,
    });
    expect(calculateTickDeltaProfileBins(levels, 0, 0, 100, 10)).toEqual({
      bins: [],
      bucketHeight: 0,
    });
  });
});

describe("smoothTickProfileBins", () => {
  it("sheds a spike into its neighbours and conserves the total volume", () => {
    const { bins } = calculateTickDeltaProfileBins(
      [
        { row: 5, buy: 8, sell: 0 },
        { row: 15, buy: 0, sell: 0 },
      ],
      1,
      0,
      100,
      10,
    );
    const before = bins.reduce((sum, bin) => sum + bin.totalVolume, 0);

    smoothTickProfileBins(bins);

    const after = bins.reduce((sum, bin) => sum + bin.totalVolume, 0);
    expect(after).toBeCloseTo(before, 10);
    // The spike keeps three quarters of itself and gives a quarter to the
    // empty row above it.
    expect(bins[0].totalVolume).toBeCloseTo(6, 10);
    expect(bins[1].totalVolume).toBeCloseTo(2, 10);
  });

  it("leaves a single bucket alone", () => {
    const { bins } = calculateTickDeltaProfileBins(
      [{ row: 5, buy: 3, sell: 1 }],
      1,
      0,
      10,
      1,
    );
    const total = bins[0].totalVolume;

    smoothTickProfileBins(bins);

    expect(bins[0].totalVolume).toBeCloseTo(total, 10);
  });
});
