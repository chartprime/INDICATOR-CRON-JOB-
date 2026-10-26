import { describe, expect, it } from "vitest";
import { bandMaxSizes, bandSizes, type LiquidityColumn } from "../liquidityGrid";
import { createBandSizeCache, type BandSizesOf } from "../liquidityBandSizes";

function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function randomColumn(random: () => number, lo: number, hi: number): LiquidityColumn {
  const rows = hi - lo + 1;
  const bid = new Float64Array(rows);
  const ask = new Float64Array(rows);
  for (let i = 0; i < rows; i += 1) {
    bid[i] = random() < 0.3 ? 0 : Math.round(random() * 5000) / 100;
    ask[i] = random() < 0.3 ? 0 : Math.round(random() * 5000) / 100;
  }
  return { ts: 1_700_000_000_000, lo, hi, bid, ask };
}

function counting(of: BandSizesOf): { of: BandSizesOf; calls: () => number } {
  let calls = 0;
  return {
    of: (column, bandIndex, clusterRows) => {
      calls += 1;
      return of(column, bandIndex, clusterRows);
    },
    calls: () => calls,
  };
}

describe("band size cache", () => {
  it("returns exactly what the style would for every band of random columns, for the sum and the biggest-row styles", () => {
    const random = seeded(5);
    const cache = createBandSizeCache();
    for (const of of [bandSizes, bandMaxSizes]) {
      for (const clusterRows of [0, 1, 2, 2.7, 3, 8]) {
        const reader = cache.reader(of, clusterRows);
        for (let n = 0; n < 12; n += 1) {
          const lo = Math.floor(random() * 40) + 3;
          const column = randomColumn(random, lo, lo + Math.floor(random() * 60));
          const rows = Math.max(1, Math.floor(clusterRows));
          for (let band = Math.floor(column.lo / rows) - 2; band <= Math.floor(column.hi / rows) + 2; band += 1) {
            const direct = of(column, band, clusterRows);
            expect(reader.both(column, band)).toEqual(direct);
            expect(reader.side(column, band, "bid")).toBe(direct.bid);
            expect(reader.side(column, band, "ask")).toBe(direct.ask);
          }
        }
      }
    }
  });

  it("reads each column once however often it is asked, and not again for a second reader with the same rows", () => {
    const column = randomColumn(seeded(1), 100, 131);
    const spy = counting(bandSizes);
    const cache = createBandSizeCache();
    const first = cache.reader(spy.of, 4);
    for (let pass = 0; pass < 20; pass += 1) for (let band = 25; band <= 32; band += 1) first.side(column, band, "bid");
    expect(spy.calls()).toBe(8);
    const second = cache.reader(spy.of, 4);
    for (let band = 25; band <= 32; band += 1) second.both(column, band);
    expect(spy.calls()).toBe(8);
  });

  it("reads the column again when the rows per band change, and again when they change back", () => {
    const column = randomColumn(seeded(2), 100, 131);
    const cache = createBandSizeCache();
    const spy = counting(bandSizes);
    expect(cache.reader(spy.of, 2).both(column, 50)).toEqual(bandSizes(column, 50, 2));
    expect(cache.reader(spy.of, 4).both(column, 25)).toEqual(bandSizes(column, 25, 4));
    expect(cache.reader(spy.of, 2).both(column, 50)).toEqual(bandSizes(column, 50, 2));
    expect(spy.calls()).toBe(16 + 8 + 16);
  });

  it("keeps the sum style and the biggest-row style apart on the same column", () => {
    const column = randomColumn(seeded(3), 100, 131);
    const cache = createBandSizeCache();
    for (let pass = 0; pass < 2; pass += 1) {
      expect(cache.reader(bandSizes, 8).both(column, 13)).toEqual(bandSizes(column, 13, 8));
      expect(cache.reader(bandMaxSizes, 8).both(column, 13)).toEqual(bandMaxSizes(column, 13, 8));
    }
    expect(bandSizes(column, 13, 8)).not.toEqual(bandMaxSizes(column, 13, 8));
  });

  it("answers a band outside the column's rows as the style does", () => {
    const column = randomColumn(seeded(4), 100, 107);
    const reader = createBandSizeCache().reader(bandSizes, 2);
    for (const band of [-5, 0, 49, 54, 55, 900]) expect(reader.both(column, band)).toEqual(bandSizes(column, band, 2));
  });

  it("falls back to the style for a column it cannot size, without throwing", () => {
    const reader = createBandSizeCache().reader(bandSizes, 2);
    const empty: LiquidityColumn = { ts: 1, lo: 5, hi: 4, bid: new Float64Array(0), ask: new Float64Array(0) };
    expect(reader.both(empty, 2)).toEqual(bandSizes(empty, 2, 2));
    const nan = { ...randomColumn(seeded(6), 100, 103), lo: Number.NaN };
    expect(() => reader.both(nan, 50)).not.toThrow();
    expect(reader.both(nan, 50)).toEqual(bandSizes(nan, 50, 2));
  });

  it("answers exactly for a column that cannot take a table, without throwing", () => {
    const column = Object.freeze(randomColumn(seeded(9), 100, 107));
    const cache = createBandSizeCache();
    const reader = cache.reader(bandSizes, 2);
    for (let band = 49; band <= 54; band += 1) expect(reader.both(column, band)).toEqual(bandSizes(column, band, 2));
    expect(cache.heldBytes).toBe(0);
  });

  it("reads one side past the cap straight from the column for the sum and biggest-row styles, and through the style for any other", () => {
    const random = seeded(11);
    const cache = createBandSizeCache(1);
    for (const [of, name] of [[bandSizes, "sum"], [bandMaxSizes, "max"]] as const) {
      const reader = cache.reader(of, 3);
      for (let i = 0; i < 20; i += 1) {
        const column = randomColumn(random, 90 + Math.floor(random() * 10), 120 + Math.floor(random() * 10));
        for (let band = 28; band <= 44; band += 1) {
          for (const side of ["bid", "ask"] as const) expect([name, band, side, reader.side(column, band, side)]).toEqual([name, band, side, of(column, band, 3)[side]]);
        }
      }
    }
    const spy = counting(bandSizes);
    const reader = cache.reader(spy.of, 3);
    const column = randomColumn(random, 100, 110);
    expect(reader.side(column, 34, "ask")).toBe(bandSizes(column, 34, 3).ask);
    expect(spy.calls()).toBe(1);
    expect(cache.heldBytes).toBe(0);
  });

  it("stops holding tables past its byte cap and still answers exactly", () => {
    const first = randomColumn(seeded(7), 100, 107);
    const second = randomColumn(seeded(8), 100, 107);
    const cache = createBandSizeCache(4 * 16);
    const spy = counting(bandSizes);
    const reader = cache.reader(spy.of, 2);
    expect(reader.both(first, 50)).toEqual(bandSizes(first, 50, 2));
    expect(cache.heldBytes).toBe(4 * 16);
    const afterFirst = spy.calls();
    expect(reader.both(second, 50)).toEqual(bandSizes(second, 50, 2));
    expect(reader.both(second, 50)).toEqual(bandSizes(second, 50, 2));
    expect(cache.heldBytes).toBe(4 * 16);
    expect(spy.calls()).toBe(afterFirst + 2);
  });
});
