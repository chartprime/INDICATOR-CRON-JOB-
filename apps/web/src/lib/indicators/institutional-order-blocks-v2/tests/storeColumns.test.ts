import { describe, expect, it } from "vitest";
import { decodeStoreColumns, type LiquidityStore } from "../calibration/storeColumns";

const GEOMETRY = { rowWidth: 0.5, deepColumnMs: 10_000 };

function store(deep: LiquidityStore["deep"]): LiquidityStore {
  return { geometry: GEOMETRY, deep };
}

describe("decodeStoreColumns", () => {
  it("reads the first column as its own entries alone, at the rows the offsets name", () => {
    const { columns, rowWidth, columnMs } = decodeStoreColumns(store([{ ts: 1, lo: 100, hi: 103, bid: [[1, 5]], ask: [[3, 2]] }]));
    expect([rowWidth, columnMs]).toEqual([0.5, 10_000]);
    expect(Array.from(columns[0].bid)).toEqual([0, 5, 0, 0]);
    expect(Array.from(columns[0].ask)).toEqual([0, 0, 0, 2]);
  });

  it("starts each column as the one before it and lands its own entries on top, a zero entry emptying a row", () => {
    const { columns } = decodeStoreColumns(store([
      { ts: 1, lo: 100, hi: 103, bid: [[1, 5], [2, 7]], ask: [] },
      { ts: 2, lo: 100, hi: 103, bid: [[2, 0], [3, 4]], ask: [[0, 1]] },
    ]));
    expect(Array.from(columns[1].bid)).toEqual([0, 5, 0, 4]);
    expect(Array.from(columns[1].ask)).toEqual([1, 0, 0, 0]);
  });

  it("carries only the rows both windows cover when the window moves, the rest reading as nothing", () => {
    const { columns } = decodeStoreColumns(store([
      { ts: 1, lo: 100, hi: 103, bid: [[0, 9], [1, 5], [3, 4]], ask: [] },
      { ts: 2, lo: 102, hi: 105, bid: [[3, 6]], ask: [] },
    ]));
    // Rows 102..105: 102 carried as 0, 103 carried as 4, 104 nothing, 105 its own 6; row 100's 9 is gone.
    expect(Array.from(columns[1].bid)).toEqual([0, 4, 0, 6]);
    expect([columns[1].lo, columns[1].hi]).toEqual([102, 105]);
  });

  it("moves the flow to the rows it printed on, since the chart keeps flow by row and the store by offset", () => {
    const { columns } = decodeStoreColumns(store([{ ts: 1, lo: 100, hi: 103, bid: [], ask: [], buy: [[2, 1.5]], sell: [[0, 0.25], [3, 2]] }]));
    expect(columns[0].buy).toEqual([[102, 1.5]]);
    expect(columns[0].sell).toEqual([[100, 0.25], [103, 2]]);
  });

  it("reads a column saved without flow as one with none", () => {
    const { columns } = decodeStoreColumns(store([{ ts: 1, lo: 100, hi: 103, bid: [], ask: [] }]));
    expect([columns[0].buy, columns[0].sell]).toEqual([[], []]);
  });
});
