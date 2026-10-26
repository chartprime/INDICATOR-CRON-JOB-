import { describe, expect, it } from "vitest";
import type { BookFrame, FrameIdentity, LiquidityFrame } from "../../../../types/frames";
import { LiquidityGrid, decodeLiquidityColumn, type LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import { liquidityStyleFor } from "../../passive-liquidity/liquidityStyle";
import { BOOK_STALE_MS, BookProfileSource, bookAgeMs, bookBands, bookExtent, isBookLive, spreadOf } from "../bookProfileSource";

const T = 1_700_000_000_000;
const crypto = liquidityStyleFor("BINANCE", "BTC-USDT", "PERPETUAL");
const nq = liquidityStyleFor("DXFEED", "/NQZ26:XCME", "FUTURE");

function column(ts: number, lo: number, bid: number[], ask: number[]): LiquidityColumn {
  return { ts, lo, hi: lo + bid.length - 1, bid: Float64Array.from(bid), ask: Float64Array.from(ask) };
}

const book = column(T, 100, [1, 0, 3, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 4, 0, 2]);

const BTC_PERP: FrameIdentity = { provider: "BINANCE", marketKind: "PERPETUAL" };
const NQ: FrameIdentity = { provider: "DXFEED", assetClass: "FUTURE" };

type FrameFields = Pick<LiquidityFrame, "symbol" | "ts" | "seq" | "reset" | "row_width" | "column_ms" | "columns">;

function frame(overrides: Partial<FrameFields> = {}, identity: FrameIdentity = BTC_PERP): LiquidityFrame {
  return {
    type: "liquidity", symbol: "BTC-USDT", ts: T, seq: 1, reset: true, row_width: 2, column_ms: 1000,
    columns: [{ ts: T, lo: 100, hi: 107, bid: [[0, 1], [2, 3]], ask: [[5, 4], [7, 2]] }],
    ...overrides,
    ...identity,
  };
}

function bookFrame(bid: number, ask: number, status: BookFrame["status"] = "READY", symbol = "BTC-USDT", identity: FrameIdentity = BTC_PERP): BookFrame {
  return {
    type: "book", symbol, status,
    bids: [{ price: bid, size: 1 }, { price: bid - 4, size: 9 }], asks: [{ price: ask, size: 1 }, { price: ask + 4, size: 9 }],
    ...identity,
  };
}

describe("bookBands", () => {
  it("counts a side that would read under one unit as empty, so an almost empty level stays empty; small rows that add up to one or more still show", () => {
    const thin = column(T, 100, [0.4, 0, 0.75, 0.25, 0, 0, 0, 0], [0, 0, 0, 2, 0, 0.49, 0.25, 0.5]);
    expect(bookBands(thin, 2, 1, crypto).map((band) => [band.index, band.bid, band.ask])).toEqual([[102, 0.75, 0], [103, 0, 2], [107, 0, 0.5]]);
    expect(bookBands(thin, 2, 2, crypto).map((band) => [band.index, band.bid, band.ask])).toEqual([[51, 1, 2], [53, 0, 0.75]]);
  });

  it("reads a band the way the market reads it: crypto sums the rows, an index takes the biggest", () => {
    expect(bookBands(book, 2, 4, crypto)).toEqual([
      { index: 25, price: 200, priceTo: 208, bid: 4, ask: 0 },
      { index: 26, price: 208, priceTo: 216, bid: 0, ask: 6 },
    ]);
    expect(bookBands(book, 2, 4, nq)).toEqual([
      { index: 25, price: 200, priceTo: 208, bid: 3, ask: 0 },
      { index: 26, price: 208, priceTo: 216, bid: 0, ask: 4 },
    ]);
  });

  it("gives one band per row at cluster 1, leaves empty bands out and keeps both sides of a band the spread sits in", () => {
    expect(bookBands(book, 2, 1, crypto)).toEqual([
      { index: 100, price: 200, priceTo: 202, bid: 1, ask: 0 },
      { index: 102, price: 204, priceTo: 206, bid: 3, ask: 0 },
      { index: 105, price: 210, priceTo: 212, bid: 0, ask: 4 },
      { index: 107, price: 214, priceTo: 216, bid: 0, ask: 2 },
    ]);
    expect(bookBands(book, 2, 8, crypto)).toEqual([{ index: 12, price: 192, priceTo: 208, bid: 4, ask: 0 }, { index: 13, price: 208, priceTo: 224, bid: 0, ask: 6 }]);
    expect(bookBands(column(T, 100, [1, 0, 0, 4], [0, 0, 5, 0]), 2, 4, crypto)).toEqual([{ index: 25, price: 200, priceTo: 208, bid: 5, ask: 5 }]);
  });

  it("reads a cluster as whole rows, at least one, like the heatmap does", () => {
    expect(bookBands(book, 2, 0, crypto)).toEqual(bookBands(book, 2, 1, crypto));
    expect(bookBands(book, 2, 4.9, crypto)).toEqual(bookBands(book, 2, 4, crypto));
    expect(bookBands(book, 2, 4, crypto)).not.toEqual(bookBands(book, 2, 5, crypto));
  });

  it("keeps prices exact on a fractional row width", () => {
    expect(bookBands(column(T, 1_000_003, [0, 2, 0], [0, 0, 1]), 0.1, 3, crypto)).toEqual([
      { index: 333_334, price: 100000.2, priceTo: 100000.5, bid: 2, ask: 0 },
      { index: 333_335, price: 100000.5, priceTo: 100000.8, bid: 0, ask: 1 },
    ]);
  });
});

describe("spreadOf", () => {
  it("is the highest bid row and the lowest ask row, null for an empty side", () => {
    expect(spreadOf(book)).toEqual({ bidRow: 102, askRow: 105 });
    expect(spreadOf(column(T, 100, [0, 0], [0, 3]))).toEqual({ bidRow: null, askRow: 101 });
    expect(spreadOf(column(T, 100, [2, 0], [0, 0]))).toEqual({ bidRow: 100, askRow: null });
  });
});

describe("bookExtent", () => {
  it("runs from the lowest row holding anything to the highest, however small, null for an empty column", () => {
    expect(bookExtent(book)).toEqual({ lowRow: 100, highRow: 107 });
    expect(bookExtent(column(T, 100, [0, 0.01, 3, 0], [0, 0, 0, 0.02]))).toEqual({ lowRow: 101, highRow: 103 });
    expect(bookExtent(column(T, 100, [0, 0, 0], [0, 5, 0]))).toEqual({ lowRow: 101, highRow: 101 });
    expect(bookExtent(column(T, 100, [0, 0], [0, 0]))).toBeNull();
    const source = new BookProfileSource(new LiquidityGrid());
    expect(source.extent()).toBeNull();
    const grid = new LiquidityGrid();
    grid.apply(frame());
    expect(new BookProfileSource(grid).extent()).toEqual({ lowRow: 100, highRow: 107 });
  });
});

describe("the dead-book rule", () => {
  it("a column is live until BOOK_STALE_MS after its time, and no column is never live", () => {
    expect(BOOK_STALE_MS).toBe(5_000);
    expect(bookAgeMs(book, T + 1_500)).toBe(1_500);
    expect(isBookLive(book, T + BOOK_STALE_MS)).toBe(true);
    expect(isBookLive(book, T + BOOK_STALE_MS + 1)).toBe(false);
    expect(isBookLive(null, T)).toBe(false);
  });
});

describe("BookProfileSource", () => {
  it("reads the grid's latest column through the grid's own market style", () => {
    const grid = new LiquidityGrid();
    grid.apply(frame());
    const source = new BookProfileSource(grid);
    expect(source.rowWidth).toBe(2);
    expect(source.bands(4)).toEqual([
      { index: 25, price: 200, priceTo: 208, bid: 4, ask: 0 },
      { index: 26, price: 208, priceTo: 216, bid: 0, ask: 6 },
    ]);
    expect(source.spread(T)).toEqual({ bidRow: 102, askRow: 105 });
    expect(source.live(T + 1_000)).toBe(true);
    expect(source.live(T + BOOK_STALE_MS + 1)).toBe(false);

    expect(source.label(9.8)).toBe("10");
    expect(source.label(0.4321)).toBe("<1");
    expect(source.label(12_600)).toBe("13k");
    const index = new LiquidityGrid();
    index.apply(frame({ symbol: "/NQZ26:XCME", row_width: 0.25 }, NQ));
    const nqSource = new BookProfileSource(index);
    expect(nqSource.bands(4).map((band) => [band.bid, band.ask])).toEqual([[3, 0], [0, 4]]);
    expect(nqSource.label(12.6)).toBe("13");
  });

  it("is empty and dead on a grid without columns", () => {
    const source = new BookProfileSource(new LiquidityGrid());
    expect(source.rowWidth).toBe(0);
    expect(source.bands(4)).toEqual([]);
    expect(source.spread(T)).toEqual({ bidRow: null, askRow: null });
    expect(source.live(T)).toBe(false);
  });

  it("keeps the bands of one column and cluster until the grid moves on", () => {
    const grid = new LiquidityGrid();
    grid.apply(frame());
    const source = new BookProfileSource(grid);
    const first = source.bands(4);
    expect(source.bands(4)).toBe(first);
    expect(source.version).toBe(grid.version);
    grid.apply(frame({ ts: T + 1000, seq: 2, reset: false, columns: [{ ts: T + 1000, lo: 100, hi: 107, bid: [[0, 9]], ask: [] }] }));
    expect(source.version).toBe(grid.version);
    const next = source.bands(4);
    expect(next).not.toBe(first);
    expect(next[0]).toEqual({ index: 25, price: 200, priceTo: 208, bid: 12, ask: 0 });
    expect(source.bands(1)).not.toBe(next);
    expect(source.bands(1)).toHaveLength(4);
  });
});

describe("BookProfileSource mid from the book frame", () => {
  it("marks the spread from the book frame's best bid and ask on the grid's rows, ahead of the once-a-second column, and counts a version only when the rows move", () => {
    const grid = new LiquidityGrid();
    grid.apply(frame());
    const source = new BookProfileSource(grid);
    const before = source.version;
    source.markBook(bookFrame(209.9, 212), T + 100);
    expect(source.spread(T + 100)).toEqual({ bidRow: 104, askRow: 106 });
    expect(source.version).toBe(before + 1);
    source.markBook(bookFrame(209.2, 213.9), T + 200);
    expect(source.version).toBe(before + 1);
    expect(source.spread(T + 200)).toEqual({ bidRow: 104, askRow: 106 });
    source.markBook(bookFrame(207.9, 212), T + 300);
    expect(source.version).toBe(before + 2);
    expect(source.spread(T + 300)).toEqual({ bidRow: 103, askRow: 106 });
    expect(source.bands(4)).toHaveLength(2);
  });

  it("goes back to the column when the book frame is older than BOOK_STALE_MS, and the next mark brings it back", () => {
    const grid = new LiquidityGrid();
    grid.apply(frame());
    const source = new BookProfileSource(grid);
    source.markBook(bookFrame(209.9, 212), T + 100);
    expect(source.spread(T + 100 + BOOK_STALE_MS)).toEqual({ bidRow: 104, askRow: 106 });
    expect(source.spread(T + 101 + BOOK_STALE_MS)).toEqual({ bidRow: 102, askRow: 105 });
    source.markBook(bookFrame(209.9, 212), T + 101 + BOOK_STALE_MS);
    expect(source.spread(T + 101 + BOOK_STALE_MS)).toEqual({ bidRow: 104, askRow: 106 });
  });

  it("reads the column when there is no usable book frame: none, unavailable, stale, a side missing, another instrument, or a grid without rows", () => {
    const grid = new LiquidityGrid();
    grid.apply(frame());
    const source = new BookProfileSource(grid);
    const before = source.version;
    source.markBook(null, T);
    expect(source.version).toBe(before);
    for (const book of [
      bookFrame(209.9, 212, "UNAVAILABLE"),
      { ...bookFrame(209.9, 212), stale: true },
      { ...bookFrame(209.9, 212), asks: [] },
      { ...bookFrame(209.9, 212), bids: [] },
      bookFrame(209.9, 212, "READY", "ETH-USDT"),
      bookFrame(209.9, 212, "READY", "BTC-USDT", { provider: "BINANCE", marketKind: "SPOT" }),
    ]) {
      source.markBook(book, T + 100);
      expect(source.spread(T + 100)).toEqual({ bidRow: 102, askRow: 105 });
      expect(source.version).toBe(before);
    }
    source.markBook(bookFrame(209.9, 212), T + 100);
    expect(source.version).toBe(before + 1);
    source.markBook(bookFrame(209.9, 212, "UNAVAILABLE"), T + 200);
    expect(source.spread(T + 200)).toEqual({ bidRow: 102, askRow: 105 });
    expect(source.version).toBe(before + 2);
    const empty = new BookProfileSource(new LiquidityGrid());
    empty.markBook(bookFrame(209.9, 212), T);
    expect(empty.spread(T)).toEqual({ bidRow: null, askRow: null });
  });

  it("keeps the rows exact on a fractional row width", () => {
    const grid = new LiquidityGrid();
    grid.apply(frame({ symbol: "ETH-USDT", row_width: 0.12, columns: [{ ts: T, lo: 21_190, hi: 21_199, bid: [[0, 1]], ask: [[9, 1]] }] }));
    const source = new BookProfileSource(grid);
    source.markBook(bookFrame(2543.28, 2543.4, "READY", "ETH-USDT"), T);
    expect(source.spread(T)).toEqual({ bidRow: 21_194, askRow: 21_195 });
    const cents = new LiquidityGrid();
    cents.apply(frame({ symbol: "SOL-USDT", row_width: 0.01, columns: [{ ts: T, lo: 200_000, hi: 200_049, bid: [[0, 1]], ask: [[49, 1]] }] }));
    const centSource = new BookProfileSource(cents);
    centSource.markBook(bookFrame(2000.12, 2000.37, "READY", "SOL-USDT"), T);
    expect(2000.12 / 0.01).toBeLessThan(200_012);
    expect(centSource.spread(T)).toEqual({ bidRow: 200_012, askRow: 200_037 });
  });

  it("marks nothing on a grid that has an instrument but no rows yet", () => {
    const grid = new LiquidityGrid();
    expect(grid.apply(frame({ reset: false }))).toBe(false);
    const source = new BookProfileSource(grid);
    expect(source.rowWidth).toBe(0);
    const before = source.version;
    source.markBook(bookFrame(209.9, 212), T);
    expect(source.spread(T)).toEqual({ bidRow: null, askRow: null });
    expect(source.version).toBe(before);
  });
});

describe("BookProfileSource resting orders", () => {
  const book = (ts: number, extra: [number, number][] = []): LiquidityFrame["columns"][number] => ({ ts, lo: 100, hi: 109, bid: [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1], ...extra], ask: [] });

  it("reads the rows at or above the multiple it is given once they have rested three seconds, following their size", () => {
    const grid = new LiquidityGrid();
    grid.apply(frame({ columns: [book(T, [[7, 9]])] }));
    const source = new BookProfileSource(grid);
    expect(source.resting(3, 3_000)).toEqual([]);
    grid.apply(frame({ ts: T + 2_999, seq: 2, reset: false, columns: [book(T + 2_999, [[7, 9], [8, 4]])] }));
    expect(source.resting(3, 3_000)).toEqual([]);
    grid.apply(frame({ ts: T + 3_000, seq: 3, reset: false, columns: [book(T + 3_000, [[7, 11], [8, 4]])] }));
    expect(source.resting(3, 3_000).map((order) => [order.key, order.size, order.since])).toEqual([["bid:107", 11, T]]);
    grid.apply(frame({ ts: T + 6_000, seq: 4, reset: false, columns: [book(T + 6_000, [[7, 11], [8, 4]])] }));
    expect(source.resting(3, 3_000).map((order) => order.key)).toEqual(["bid:107", "bid:108"]);
  });

  it("waits half a minute without a wait of its own", () => {
    const grid = new LiquidityGrid();
    grid.apply(frame({ columns: [book(T, [[7, 9]])] }));
    const source = new BookProfileSource(grid);
    source.resting(3);
    grid.apply(frame({ ts: T + 29_000, seq: 2, reset: false, columns: [book(T + 29_000, [[7, 9]])] }));
    expect(source.resting(3)).toEqual([]);
    grid.apply(frame({ ts: T + 30_000, seq: 3, reset: false, columns: [book(T + 30_000, [[7, 9]])] }));
    expect(source.resting(3)).toHaveLength(1);
  });

});

describe("decodeLiquidityColumn feeds the same shape", () => {
  it("a decoded wire column reads like a hand-built one", () => {
    const decoded = decodeLiquidityColumn(null, frame().columns[0]);
    expect(bookBands(decoded, 2, 4, crypto)).toEqual(bookBands(book, 2, 4, crypto));
  });
});
