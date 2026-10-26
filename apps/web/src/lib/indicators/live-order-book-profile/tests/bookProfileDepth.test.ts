import { describe, expect, it } from "vitest";
import type { FrameIdentity, LiquidityFrame } from "../../../../types/frames";
import { LiquidityGrid, type LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import type { HeatLanes } from "../../passive-liquidity/liquidityLanes";
import { liquidityStyleFor } from "../../passive-liquidity/liquidityStyle";
import { BookProfileSource, bookBands, bookExtent } from "../bookProfileSource";

const T = 1_700_000_000_000;
const crypto = liquidityStyleFor("BINANCE", "BTC-USDT", "PERPETUAL");
const nq = liquidityStyleFor("DXFEED", "/NQZ26:XCME", "FUTURE");
const BTC_PERP: FrameIdentity = { provider: "BINANCE", marketKind: "PERPETUAL" };
const NQ: FrameIdentity = { provider: "DXFEED", assetClass: "FUTURE" };

function column(ts: number, lo: number, bid: number[], ask: number[]): LiquidityColumn {
  return { ts, lo, hi: lo + bid.length - 1, bid: Float64Array.from(bid), ask: Float64Array.from(ask) };
}

function lanesOf(byLane: Record<number, LiquidityGrid>): HeatLanes {
  return { grid: (lane) => byLane[lane] ?? null };
}

function gridOf(rowWidth: number, lo: number, bid: [number, number][], ask: [number, number][], identity: FrameIdentity = BTC_PERP, symbol = "BTC-USDT", seq = 1): LiquidityGrid {
  const grid = new LiquidityGrid();
  const span = Math.max(...bid.map(([row]) => row), ...ask.map(([row]) => row), 0);
  const frame: LiquidityFrame = { type: "liquidity", symbol, ts: T, seq, reset: true, row_width: rowWidth, column_ms: 1000, columns: [{ ts: T, lo, hi: lo + span, bid, ask }], ...identity };
  grid.apply(frame);
  return grid;
}

// The finest column holds rows 100..107 (prices 200..216 at a width of 2). The x2 lane holds rows 44..58 of width 4
// (prices 176..236), the x4 lane rows 20..32 of width 8 (prices 160..264): each wider lane reaches past the finer one.
// The x4 lane also holds a bid at 176 and an ask at 224, inside the x2 lane's reach, which the x2 lane's own reading must win.
const fine = column(T, 100, [1, 0, 3, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 4, 0, 2]);
const x2 = column(T, 44, [5, 1, 0, 0, 0, 0, 9, 9, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 0, 0, 0, 0, 7]);
const x4 = column(T, 20, [10, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 20]);
const wider = [{ factor: 2, rowWidth: 4, latest: x2 }, { factor: 4, rowWidth: 8, latest: x4 }];

describe("bookBands over the wider lanes", () => {
  it("reads the finest column inside its window and the wider lanes beyond it, the finest lane that reaches a price first, in price order", () => {
    expect(bookBands(fine, 2, 4, crypto, wider)).toEqual([
      { index: 20, price: 160, priceTo: 168, bid: 10, ask: 0 },
      { index: 22, price: 176, priceTo: 184, bid: 6, ask: 0 },
      { index: 25, price: 200, priceTo: 208, bid: 4, ask: 0 },
      { index: 26, price: 208, priceTo: 216, bid: 0, ask: 6 },
      { index: 29, price: 232, priceTo: 240, bid: 0, ask: 7 },
      { index: 32, price: 256, priceTo: 264, bid: 0, ask: 20 },
    ]);
    // Without the lanes the finest window is all there is, as before.
    expect(bookBands(fine, 2, 4, crypto)).toEqual([
      { index: 25, price: 200, priceTo: 208, bid: 4, ask: 0 },
      { index: 26, price: 208, priceTo: 216, bid: 0, ask: 6 },
    ]);
  });

  it("never lets a wider lane overwrite a price the finest column covers, even where the lane holds something there", () => {
    // The x2 lane's rows 50..53 (prices 200..216) hold 9+9 bid and 2+2 ask over the finest window: the finest column's 4 and 6 win.
    const bands = bookBands(fine, 2, 4, crypto, wider);
    expect(bands.filter((band) => band.price >= 200 && band.price < 216).map((band) => [band.bid, band.ask])).toEqual([[4, 0], [0, 6]]);
    expect(bands.filter((band) => band.price >= 176 && band.price < 200)).toEqual([{ index: 22, price: 176, priceTo: 184, bid: 6, ask: 0 }]);
    // The x4 lane's 6 at 176 and 3 at 224 sit inside the x2 lane's reach: the x2 lane's reading stands, holding something or nothing.
    expect(bands.filter((band) => band.price >= 216 && band.price < 232)).toEqual([]);
  });

  it("reads a lane row the market's way: an index band is its biggest tick, crypto sums", () => {
    expect(bookBands(fine, 2, 4, nq, wider).map((band) => [band.price, band.bid, band.ask])).toEqual([[160, 10, 0], [176, 5, 0], [200, 3, 0], [208, 0, 4], [232, 0, 7], [256, 0, 20]]);
  });

  it("on a cluster the lane's rows do not divide, draws the lane's own rows at their own prices", () => {
    // Three finest rows a band: the x2 lane's rows (two finest rows) stand on their own, the x4 lane's (four) too.
    const bands = bookBands(fine, 2, 3, crypto, wider);
    expect(bands.map((band) => [band.index, band.price, band.priceTo, band.bid, band.ask])).toEqual([
      [26, 160, 168, 10, 0],
      [29, 176, 180, 5, 0],
      [30, 180, 184, 1, 0],
      [33, 198, 204, 1, 0],
      [34, 204, 210, 3, 0],
      [35, 210, 216, 0, 6],
      [38, 232, 236, 0, 7],
      [42, 256, 264, 0, 20],
    ]);
  });

  it("stretches the extent over the lanes' rows, in the finest rows", () => {
    expect(bookExtent(fine)).toEqual({ lowRow: 100, highRow: 107 });
    expect(bookExtent(fine, wider)).toEqual({ lowRow: 80, highRow: 131 });
    expect(bookExtent(column(T, 100, [0, 0], [0, 0]), wider)).toEqual({ lowRow: 80, highRow: 131 });
    expect(bookExtent(column(T, 100, [0, 0], [0, 0]), [{ factor: 2, rowWidth: 4, latest: column(T, 44, [0], [0]) }])).toBeNull();
  });
});

describe("BookProfileSource over the lanes", () => {
  it("reads the lanes the chart gives it, moves its version with theirs, and reads only the lanes whose rows are a whole multiple of the grid's", () => {
    const grid = gridOf(2, 100, [[0, 1], [2, 3]], [[5, 4], [7, 2]]);
    const lane2 = gridOf(4, 44, [[0, 5], [1, 1], [6, 9], [7, 9]], [[8, 2], [9, 2], [14, 7]]);
    const lane4 = gridOf(8, 20, [[0, 10], [2, 6]], [[8, 3], [12, 20]]);
    const odd = gridOf(3, 10, [[0, 50]], []);
    const source = new BookProfileSource(grid, lanesOf({ 1: lane2, 2: lane4, 3: odd }));
    expect(source.bands(4).map((band) => [band.price, band.bid, band.ask])).toEqual([[160, 10, 0], [176, 6, 0], [200, 4, 0], [208, 0, 6], [232, 0, 7], [256, 0, 20]]);
    expect(source.extent()).toEqual({ lowRow: 80, highRow: 131 });
    const version = source.version;
    const bands = source.bands(4);
    expect(source.bands(4)).toBe(bands);
    lane4.apply({ type: "liquidity", symbol: "BTC-USDT", ts: T + 1000, seq: 2, reset: false, row_width: 8, column_ms: 1000, columns: [{ ts: T + 1000, lo: 20, hi: 32, bid: [[0, 11]], ask: [] }], ...BTC_PERP });
    expect(source.version).toBeGreaterThan(version);
    expect(source.bands(4)).not.toBe(bands);
    expect(source.bands(4)[0]).toEqual({ index: 20, price: 160, priceTo: 168, bid: 11, ask: 0 });
    source.setLanes(null);
    expect(source.bands(4).map((band) => band.price)).toEqual([200, 208]);
    expect(source.extent()).toEqual({ lowRow: 100, highRow: 107 });
  });

  it("an index book reads its lanes by the biggest tick", () => {
    const grid = gridOf(0.25, 100, [[0, 1], [2, 3]], [[5, 4], [7, 2]], NQ, "/NQZ26:XCME");
    const lane2 = gridOf(0.5, 44, [[0, 5], [6, 9], [7, 9]], [[14, 7]], NQ, "/NQZ26:XCME");
    const source = new BookProfileSource(grid, lanesOf({ 1: lane2 }));
    expect(source.bands(4).map((band) => [band.bid, band.ask])).toEqual([[5, 0], [3, 0], [0, 4], [0, 7]]);
  });
});
