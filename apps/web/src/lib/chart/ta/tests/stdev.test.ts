import { describe, expect, it } from "vitest";
import { stdev } from "../stdev";

describe("stdev -- hand-computed exact values", () => {
  it("is null before the window is full, then the population standard deviation of the last `length` values", () => {
    const s = stdev(3);
    expect(s.push(1, false)).toBeNull();
    expect(s.push(2, false)).toBeNull();
    // window [1,2,3]: mean=2, variance=(1+0+1)/3=0.6667, stdev=sqrt(0.6667)
    expect(s.push(3, false)).toBeCloseTo(0.8165, 4);
  });

  it("tracks the moving window correctly across the rest of the series", () => {
    const s = stdev(3);
    s.push(1, false);
    s.push(2, false);
    s.push(3, false);
    // window [2,3,4]: mean=3, variance=(1+0+1)/3=0.6667
    expect(s.push(4, false)).toBeCloseTo(0.8165, 4);
    // window [3,4,5]: mean=4, variance=(1+0+1)/3=0.6667
    expect(s.push(5, false)).toBeCloseTo(0.8165, 4);
  });

  it("returns 0 for a flat window (no dispersion)", () => {
    const s = stdev(3);
    s.push(5, false);
    s.push(5, false);
    expect(s.push(5, false)).toBe(0);
  });
});

describe("stdev -- degenerate length arguments fail closed", () => {
  it("returns null rather than NaN for a zero, negative or fractional length", () => {
    expect(stdev(0).push(5, false)).toBeNull();
    expect(stdev(-3).push(5, false)).toBeNull();
    expect(stdev(2.5).push(5, false)).toBeNull();
  });
});

describe("stdev -- live replace semantics", () => {
  it("a replace:true revision recomputes a different value without corrupting the committed baseline", () => {
    const s = stdev(3);
    s.push(1, false);
    s.push(2, false);
    const firstValue = s.push(3, false);

    const revisedValue = s.push(999, true);

    expect(revisedValue).not.toBe(firstValue);
  });

  it("multiple replace:true revisions for the same bar are each computed fresh from the same committed baseline, not accumulated", () => {
    const s = stdev(3);
    s.push(1, false);
    s.push(2, false);
    s.push(3, false);
    s.push(100, true); // a wild, discarded revision
    const secondRevision = s.push(4, true); // revise again, back to a plain value

    const fresh = stdev(3);
    fresh.push(1, false);
    fresh.push(2, false);
    fresh.push(3, false);
    const freshFirstRevision = fresh.push(4, true);

    expect(secondRevision).toBe(freshFirstRevision);
  });

  it("keeps exact moving-window results over a long series without retaining old values", () => {
    const length = 50;
    const s = stdev(length);
    for (let value = 1; value <= 1_000; value += 1) s.push(value, false);
    // The last window is 951..1000. Consecutive integers have population
    // variance (n^2 - 1) / 12, independent of their absolute level.
    expect(s.push(1_001, false)).toBeCloseTo(Math.sqrt((length ** 2 - 1) / 12), 10);
  });

  it("retains a small dispersion accurately around a BTC-scale price level", () => {
    const s = stdev(3);
    s.push(100_000, false);
    s.push(100_000.01, false);
    expect(s.push(100_000.02, false)).toBeCloseTo(Math.sqrt(2 / 3) / 100, 10);
  });
});
