const { sampleLiquidityColumn, quantizeSize, rowOf, laneFoldFor } = require("../../../src/indicators/passive_liquidity/liquidity-sampler");

const level = (key, size) => ({ key, size });

describe("liquidity-sampler", () => {
  test("quantizeSize keeps two significant digits and leaves zero alone", () => {
    expect(quantizeSize(12.34)).toBe(12);
    expect(quantizeSize(0.01234)).toBe(0.012);
    expect(quantizeSize(1.25, 3)).toBe(1.25);
    expect(quantizeSize(0)).toBe(0);
    expect(quantizeSize(-3)).toBe(0);
  });

  test("rowOf groups consecutive ledger keys", () => {
    expect(rowOf(0, 4)).toBe(0);
    expect(rowOf(3, 4)).toBe(0);
    expect(rowOf(4, 4)).toBe(1);
    expect(rowOf(100, 1)).toBe(100);
  });

  test("collapses bands into rows around the mid and clips to the window", () => {
    const snapshot = {
      bestBidKey: 99, // row 24 with rowClusters 4
      bestAskKey: 101, // row 25 -> mid 100 -> row 25
      bids: [level(99, 1), level(98, 0.5), level(96, 2), level(4, 100)], // rows 24, 24, 24, 1
      asks: [level(101, 3), level(104, 0.25), level(105, 0), level(140, 7)], // rows 25, 26, 26 (zero), 35
    };
    const column = sampleLiquidityColumn(snapshot, { ts: 1_000, rowClusters: 4, windowRows: 2 });
    expect(column.ts).toBe(1_000);
    expect(column.lo).toBe(23);
    expect(column.hi).toBe(27);
    expect(Array.from(column.bid)).toEqual([0, 3.5, 0, 0, 0]);
    expect(Array.from(column.ask)).toEqual([0, 0, 3, 0.25, 0]);
  });

  test("centres on whichever side exists when the other is empty", () => {
    const onlyBids = sampleLiquidityColumn({ bestBidKey: 40, bestAskKey: null, bids: [level(40, 1)], asks: [] }, { ts: 5, rowClusters: 1, windowRows: 1 });
    expect([onlyBids.lo, onlyBids.hi]).toEqual([39, 41]);
    expect(Array.from(onlyBids.bid)).toEqual([0, 1, 0]);
    const onlyAsks = sampleLiquidityColumn({ bestBidKey: null, bestAskKey: 40, bids: [], asks: [level(40, 1)] }, { ts: 5, rowClusters: 1, windowRows: 1 });
    expect(Array.from(onlyAsks.ask)).toEqual([0, 1, 0]);
  });

  test("returns null with no best price at all", () => {
    expect(sampleLiquidityColumn({ bestBidKey: null, bestAskKey: null, bids: [], asks: [] }, { ts: 5, rowClusters: 1, windowRows: 1 })).toBeNull();
  });

  test("never produces a negative low row", () => {
    const column = sampleLiquidityColumn({ bestBidKey: 1, bestAskKey: 2, bids: [], asks: [] }, { ts: 5, rowClusters: 1, windowRows: 10 });
    expect(column.lo).toBe(0);
    expect(column.hi).toBe(11);
  });

  test("quantizes each cell after summing", () => {
    const column = sampleLiquidityColumn({ bestBidKey: 10, bestAskKey: 11, bids: [level(10, 1.234), level(10, 2.345)], asks: [] }, { ts: 5, rowClusters: 1, windowRows: 0, sizeDigits: 3 });
    expect(Array.from(column.bid)).toEqual([3.58]);
  });

  test("a max fold keeps each row's biggest tick where the default sums them, and only sum and max are folds", () => {
    // Two ticks a row: bids 98 and 99 share row 49, 97 sits in row 48; asks 101 in row 50, 102 in row 51.
    const snapshot = { bestBidKey: 99, bestAskKey: 101, bids: [level(99, 5), level(98, 4), level(97, 9)], asks: [level(101, 3), level(102, 6)] };
    const summed = sampleLiquidityColumn(snapshot, { ts: 1, rowClusters: 2, windowRows: 2 });
    const biggest = sampleLiquidityColumn(snapshot, { ts: 1, rowClusters: 2, windowRows: 2, fold: "max" });
    expect([summed.lo, summed.hi, biggest.lo, biggest.hi]).toEqual([48, 52, 48, 52]);
    expect(Array.from(summed.bid)).toEqual([9, 9, 0, 0, 0]);
    expect(Array.from(biggest.bid)).toEqual([9, 5, 0, 0, 0]);
    expect(Array.from(biggest.ask)).toEqual(Array.from(summed.ask));
    expect(Array.from(sampleLiquidityColumn(snapshot, { ts: 1, rowClusters: 2, windowRows: 2, fold: "sum" }).bid)).toEqual([9, 9, 0, 0, 0]);
    // One tick a row: the two folds agree.
    expect(Array.from(sampleLiquidityColumn(snapshot, { ts: 1, rowClusters: 1, windowRows: 2, fold: "max" }).bid)).toEqual(Array.from(sampleLiquidityColumn(snapshot, { ts: 1, rowClusters: 1, windowRows: 2 }).bid));
    expect(() => sampleLiquidityColumn(snapshot, { ts: 1, rowClusters: 2, windowRows: 2, fold: "mean" })).toThrow(/fold/);
  });

  test("futures and equity books fold their lanes by the biggest tick, crypto books by the sum", () => {
    expect([laneFoldFor("FUTURE"), laneFoldFor("EQUITY"), laneFoldFor("SPOT"), laneFoldFor("PERPETUAL"), laneFoldFor(undefined)]).toEqual(["max", "max", "sum", "sum", "sum"]);
  });

  test("rejects bad parameters", () => {
    const snapshot = { bestBidKey: 10, bestAskKey: 11, bids: [], asks: [] };
    expect(() => sampleLiquidityColumn(snapshot, { ts: -1, rowClusters: 1, windowRows: 1 })).toThrow(/ts/);
    expect(() => sampleLiquidityColumn(snapshot, { ts: 1, rowClusters: 0, windowRows: 1 })).toThrow(/rowClusters/);
    expect(() => sampleLiquidityColumn(snapshot, { ts: 1, rowClusters: 1, windowRows: -1 })).toThrow(/windowRows/);
  });
});
