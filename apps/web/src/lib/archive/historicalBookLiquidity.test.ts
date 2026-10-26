import { describe, expect, it } from "vitest";
import { historicalBookLiquidity } from "./historicalBookLiquidity";
import type { HistoricalBookSecond } from "./historicalL2States";

function second(openMs: number, knownNs = BigInt(openMs + 1000) * 1000000n, segment = "a".repeat(64)): HistoricalBookSecond {
  return { openNs: String(BigInt(openMs) * 1000000n), closeNs: String(BigInt(openMs + 1000) * 1000000n), knownNs: String(knownNs),
    knownKey: null, segmentId: segment, complete: true, trusted: true, reason: "OBSERVED_PREFIX",
    flow: { BUY: 0, SELL: 0, UNKNOWN: 1, count: 1 },
    column: { ts: openMs, lo: 400, hi: 401, bid: new Float64Array([5, NaN]), ask: new Float64Array([NaN, 6]), buy: [], sell: [] } };
}

describe("historical liquidity input", () => {
  it("cuts by exact knowledge time, retains unknown cells and does not turn aggregate flow into individual prints", () => {
    const rows = [second(0), second(1000, 2000000001n)];
    const source = historicalBookLiquidity(rows, 0.25, 1, "contracts");
    expect(source.atTime!(999)?.feed.fine.columns).toHaveLength(0);
    expect(source.atTime!(1000)?.feed.fine.columns).toEqual([rows[0].column]);
    expect(source.atTime!(2000)?.feed.fine.columns).toHaveLength(1);
    expect(source.atTime!(2001)?.feed.fine.columns).toHaveLength(2);
    expect(source.baseAsset).toBe("contracts");
    expect(source.rowWidth).toBe(0.25);
    expect(source.history).toBeNull();
    expect(source.feed.deep).toBeNull();
    const column = source.feed.fine.columns[0];
    expect(column).toBe(rows[0].column);
    expect(Number.isNaN(column.bid[1])).toBe(true);
    expect(Number.isNaN(column.ask[0])).toBe(true);
    expect(column.prints).toBeUndefined();
    expect(column.reference).toBeUndefined();
  });
  it("never widens a previous cut and rejects invalid time instead of falling back to the full archive", () => {
    const source = historicalBookLiquidity([second(0), second(1000)], 0.01, 1, "shares");
    const early = source.atTime!(1000)!;
    expect(early.atTime!(2000)?.feed.fine.columns).toHaveLength(1);
    for (const time of [-1, NaN, Infinity, 1.5]) expect(source.atTime!(time)).toBeNull();
    expect(source.atTime!(2000)).toBe(source.atTime!(2000));
    expect(source.feed.fine.columns).toBe(source.feed.fine.columns);
  });
  it("resets rolling evidence at explicit gaps, partial seconds, changed segments and missing seconds", () => {
    const gap = { ...second(1000), segmentId: null, trusted: false, column: null, reason: "SOURCE_GAP" };
    const rows = [second(0), gap, second(2000), second(3000), second(4000, undefined, "b".repeat(64)), second(6000, undefined, "b".repeat(64))];
    const source = historicalBookLiquidity(rows, 0.25, 4, "contracts");
    expect(source.atTime!(2000)?.feed.fine.columns).toEqual([]);
    expect(source.atTime!(4000)?.feed.fine.columns.map((col) => col.ts)).toEqual([2000, 3000]);
    expect(source.atTime!(5000)?.feed.fine.columns.map((col) => col.ts)).toEqual([4000]);
    expect(source.atTime!(7000)?.feed.fine.columns.map((col) => col.ts)).toEqual([6000]);
    const epochs = [1000, 2000, 3000, 5000, 7000].map((time) => source.atTime!(time)!.feed.epoch);
    expect(new Set(epochs).size).toBe(5);
    const partial = { ...second(1000), complete: false, column: null };
    expect(historicalBookLiquidity([second(0), partial], 0.25, 5, "contracts").feed.fine.columns).toEqual([]);
    expect(historicalBookLiquidity(rows, 0.25, 5, "contracts").feed.epoch).not.toBe(source.feed.epoch);
  });
  it("bounds geometry, epoch arithmetic and source order before exposing columns", () => {
    for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(() => historicalBookLiquidity([], 0.25, version, "contracts")).toThrow("geometry");
    }
    expect(() => historicalBookLiquidity([], 1, 1, "shares")).toThrow("geometry");
    expect(() => historicalBookLiquidity(Array(7201).fill(second(0)), 0.25, 1, "contracts")).toThrow("geometry");
    expect(() => historicalBookLiquidity([second(1000), second(0)], 0.25, 1, "contracts")).toThrow("regresses");
    expect(() => historicalBookLiquidity([{ ...second(0), trusted: false }], 0.25, 1, "contracts")).toThrow("complete/trusted");
    expect(() => historicalBookLiquidity([second(0, 1n)], 0.25, 1, "contracts")).toThrow("time differs");
  });
  it("admits partial coverage at the same second boundary without carrying its rolling evidence into the new segment", () => {
    const point = { ...second(0, 0n), closeNs: "0", complete: false, trusted: false, segmentId: null, column: null };
    const source = historicalBookLiquidity([point, second(0)], 0.25, 1, "contracts");
    expect(source.atTime!(0)?.feed.fine.columns).toHaveLength(0);
    expect(source.atTime!(1000)?.feed.fine.columns.map((col) => col.ts)).toEqual([0]);
    expect(source.atTime!(0)?.feed.epoch).not.toBe(source.atTime!(1000)?.feed.epoch);
  });
});
