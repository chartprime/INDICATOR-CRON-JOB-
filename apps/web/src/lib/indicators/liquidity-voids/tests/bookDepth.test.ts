import { describe, expect, it } from "vitest";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import { DEPTH_TYPICAL_MS, MIN_DEPTH_SAMPLES, createBookDepth, fillDistance, judgeBook, noteDepth, resetBookDepth } from "../bookDepth";

const T = 1_700_000_011_000;
const S = 1_000;
const ROW = 4;

function column(bid: readonly number[], ask: readonly number[]): LiquidityColumn {
  return { ts: T, lo: 100, hi: 100 + bid.length - 1, bid: Float64Array.from(bid), ask: Float64Array.from(ask) };
}

function filled(values: readonly number[], stepMs = S) {
  const state = createBookDepth();
  values.forEach((value, i) => noteDepth(state, T + i * stepMs, value));
  return state;
}

describe("bookDepth", () => {
  it("measures how far price travels through the book to fill a size: the rows from each touch until the resting size covers it, averaged over the two sides, the whole side when it never covers it, and no reading without a touch on both sides", () => {
    const c = column([0, 7, 3, 4, 0, 0, 0, 0], [0, 0, 0, 0, 5, 2, 9, 0]);
    expect(fillDistance(c, 4, ROW)).toBe(((1 + 1) / 2) * ROW);
    expect(fillDistance(c, 7, ROW)).toBe(((2 + 2) / 2) * ROW);
    expect(fillDistance(c, 10, ROW)).toBe(((3 + 3) / 2) * ROW);
    expect(fillDistance(c, 15, ROW)).toBe(((4 + 3) / 2) * ROW);
    expect(fillDistance(c, 100, ROW)).toBe(((4 + 4) / 2) * ROW);
    expect(fillDistance(column([0, 0, 0], [1, 1, 1]), 2, ROW)).toBeNull();
    expect(fillDistance(column([1, 1, 1], [0, 0, 0]), 2, ROW)).toBeNull();
  });

  it("keeps the last hour of samples and ignores a sample that does not move time forward", () => {
    const state = filled([1, 2, 3], DEPTH_TYPICAL_MS / 2);
    expect(state.samples.map((s) => s.value)).toEqual([1, 2, 3]);
    noteDepth(state, T + DEPTH_TYPICAL_MS, 9);
    expect(state.samples.map((s) => s.value)).toEqual([1, 2, 3]);
    noteDepth(state, T + 1.5 * DEPTH_TYPICAL_MS, 4);
    expect(state.samples.map((s) => s.value)).toEqual([2, 3, 4]);
    noteDepth(state, T + 3 * DEPTH_TYPICAL_MS, 5);
    expect(state.samples.map((s) => s.value)).toEqual([5]);
  });

  it("judges the spread now against the median of the last hour: over one and a half is a thin book, under half is a thick book, between is normal, and says nothing before sixty samples", () => {
    const quiet = Array.from({ length: MIN_DEPTH_SAMPLES - 1 }, () => 10);
    expect(judgeBook(filled([...quiet]))).toBeNull();
    expect(judgeBook(filled([...quiet, 16]))).toMatchObject({ value: 16, typical: 10, ratio: 1.6, label: "thin book" });
    expect(judgeBook(filled([...quiet, 15]))).toMatchObject({ ratio: 1.5, label: "normal book" });
    expect(judgeBook(filled([...quiet, 5]))).toMatchObject({ ratio: 0.5, label: "normal book" });
    expect(judgeBook(filled([...quiet, 4]))).toMatchObject({ value: 4, ratio: 0.4, label: "thick book" });
    expect(judgeBook(filled(Array.from({ length: MIN_DEPTH_SAMPLES }, () => 0)))).toBeNull();
  });

  it("takes the median, not the mean: thirty quiet samples and twenty-nine wide ones leave a reading of twice the quiet spread normal", () => {
    const state = filled([...Array.from({ length: 30 }, () => 10), ...Array.from({ length: 29 }, () => 100), 20]);
    expect(judgeBook(state)).toMatchObject({ typical: 20, ratio: 1, label: "normal book" });
    resetBookDepth(state);
    expect(state.samples).toEqual([]);
    expect(judgeBook(state)).toBeNull();
  });
});
