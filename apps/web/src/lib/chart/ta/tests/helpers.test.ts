import { describe, expect, it } from "vitest";
import {
  crossover,
  crossunder,
  highest,
  lowest,
  pivotHigh,
  pivotLow,
  prev,
} from "../helpers";

describe("highest / lowest -- hand-computed exact values, one push per bar", () => {
  it("highest(3) tracks the max of the last 3 committed values plus the tentative one", () => {
    const h = highest(3);
    expect(h.push(1, false)).toBeNull();
    expect(h.push(5, false)).toBeNull();
    expect(h.push(2, false)).toBe(5); // window [1,5,2]
    expect(h.push(3, false)).toBe(5); // window [5,2,3]
    expect(h.push(1, false)).toBe(3); // window [2,3,1] -- 5 has rolled off
  });

  it("lowest(3) tracks the min of the last 3 committed values plus the tentative one", () => {
    const l = lowest(3);
    l.push(5, false);
    l.push(1, false);
    expect(l.push(4, false)).toBe(1); // window [5,1,4]
    expect(l.push(3, false)).toBe(1); // window [1,4,3]
    expect(l.push(9, false)).toBe(3); // window [4,3,9] -- 1 has rolled off
  });

  it("multiple replace:true revisions for one bar are each computed fresh, and only the last one commits", () => {
    const withReplace = highest(3);
    withReplace.push(1, false); // bar A
    withReplace.push(2, false); // bar B, settles at 2 below
    withReplace.push(999, true); // a wild, discarded revision of bar B
    withReplace.push(2, true); // revise bar B again, back to its real final value
    withReplace.push(3, false); // bar C (commits bar B's final value: 2)
    const nextBarWithReplace = withReplace.push(4, false); // bar D

    const straight = highest(3);
    straight.push(1, false); // bar A
    straight.push(2, false); // bar B, pushed straight
    straight.push(3, false); // bar C
    const nextBarStraight = straight.push(4, false); // bar D

    expect(nextBarWithReplace).toBe(nextBarStraight);
    expect(nextBarWithReplace).toBe(4);
  });

  it("handles a long lookback without spreading or rescanning a full window per live update", () => {
    const h = highest(10_000);
    for (let value = 1; value <= 10_000; value += 1) h.push(value, false);
    expect(h.push(10_001, false)).toBe(10_001);
  });
});

describe("prev -- hand-computed exact values", () => {
  it("prev(1) returns the previous bar's value, null until one exists", () => {
    const p = prev(1);
    expect(p.push(10, false)).toBeNull();
    expect(p.push(20, false)).toBe(10);
    expect(p.push(30, false)).toBe(20);
  });

  it("prev(2) returns the value from two bars back", () => {
    const p = prev(2);
    expect(p.push(10, false)).toBeNull();
    expect(p.push(20, false)).toBeNull();
    expect(p.push(30, false)).toBe(10);
    expect(p.push(40, false)).toBe(20);
  });

  it("a replace:true revision of the current bar does not shift the lookback window", () => {
    const p = prev(1);
    p.push(10, false);
    p.push(20, false); // prev(1) here is 10
    const duringReplace = p.push(999, true);
    expect(duringReplace).toBe(10);
    // the bar after the replace should see 999 (the final, replaced value),
    // not the original 20.
    expect(p.push(30, false)).toBe(999);
  });
});

describe("pivot high / low -- centered confirmation", () => {
  it("returns a pivot high only after the right-side bars arrive", () => {
    const high = pivotHigh(2, 1);
    expect(high.push(1, false)).toBeNull();
    expect(high.push(3, false)).toBeNull();
    expect(high.push(5, false)).toBeNull();
    expect(high.push(2, false)).toBe(5); // candidate 5 has [1, 3] to the left and [2] to the right
  });

  it("returns a pivot low with asymmetric left and right strengths", () => {
    const low = pivotLow(1, 2);
    expect(low.push(5, false)).toBeNull();
    expect(low.push(2, false)).toBeNull();
    expect(low.push(1, false)).toBeNull();
    expect(low.push(3, false)).toBeNull();
    expect(low.push(4, false)).toBe(1); // candidate 1 has [2] to the left and [3, 4] to the right
  });

  it("rejects equal neighboring values", () => {
    const high = pivotHigh(1, 1);
    high.push(1, false);
    high.push(3, false);
    expect(high.push(3, false)).toBeNull();

    const low = pivotLow(1, 1);
    low.push(3, false);
    low.push(1, false);
    expect(low.push(1, false)).toBeNull();
  });

  it("uses the final replacement when confirming a later pivot", () => {
    const withReplace = pivotHigh(1, 1);
    withReplace.push(1, false);
    withReplace.push(5, false);
    withReplace.push(4, true);
    const replacedResult = withReplace.push(2, false);

    const straight = pivotHigh(1, 1);
    straight.push(1, false);
    straight.push(4, false);
    expect(replacedResult).toBe(straight.push(2, false));
    expect(replacedResult).toBe(4);
  });

  it("fails closed for invalid strengths and non-finite windows", () => {
    expect(pivotHigh(0, 1).push(5, false)).toBeNull();
    expect(pivotLow(1, 1.5).push(5, false)).toBeNull();

    const high = pivotHigh(1, 1);
    high.push(1, false);
    high.push(Number.NaN, false);
    expect(high.push(2, false)).toBeNull();
  });

  it("handles a long lookback without spreading or rescanning the full history per live update", () => {
    const high = pivotHigh(5, 5);
    for (let value = 1; value <= 50_000; value += 1) high.push(value, false);
    const start = performance.now();
    for (let value = 1; value <= 10_000; value += 1) high.push(value, false);
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe("degenerate length arguments fail closed", () => {
  it("highest/lowest return null rather than -Infinity/Infinity for a zero, negative or fractional length", () => {
    expect(highest(0).push(5, false)).toBeNull();
    expect(lowest(0).push(5, false)).toBeNull();
    expect(highest(-2).push(5, false)).toBeNull();
    expect(lowest(1.5).push(5, false)).toBeNull();
  });

  it("prev returns null rather than undefined for a zero, negative or fractional offset", () => {
    const p = prev(0);
    p.push(5, false);
    expect(p.push(6, false)).toBeNull();
    expect(prev(-1).push(5, false)).toBeNull();
    expect(prev(1.5).push(5, false)).toBeNull();
  });
});

describe("crossover / crossunder", () => {
  it("crossover fires only on the bar a moves from at-or-below b to strictly above it", () => {
    const c = crossover();
    expect(c.push({ a: 1, b: 2 }, false)).toBe(false);
    expect(c.push({ a: 2, b: 2 }, false)).toBe(false); // still at-or-below
    expect(c.push({ a: 3, b: 2 }, false)).toBe(true); // crosses now
    expect(c.push({ a: 4, b: 2 }, false)).toBe(false); // already above, not a fresh cross
  });

  it("crossunder fires only on the bar a moves from at-or-above b to strictly below it", () => {
    const c = crossunder();
    expect(c.push({ a: 5, b: 2 }, false)).toBe(false);
    expect(c.push({ a: 2, b: 2 }, false)).toBe(false); // still at-or-above
    expect(c.push({ a: 1, b: 2 }, false)).toBe(true); // crosses now
    expect(c.push({ a: 0, b: 2 }, false)).toBe(false); // already below
  });

  it("never fires on the very first bar -- there is no prior relationship yet", () => {
    expect(crossover().push({ a: 100, b: 1 }, false)).toBe(false);
    expect(crossunder().push({ a: 1, b: 100 }, false)).toBe(false);
  });

  it("the next distinct bar commits the latest replaced relationship, not the original one", () => {
    const withReplace = crossover();
    withReplace.push({ a: 1, b: 2 }, false);
    withReplace.push({ a: 5, b: 2 }, true); // revise this same bar to already be above
    // committed prior is now (5,2) -- already above -- so (6,2) is not a fresh cross.
    const withReplaceResult = withReplace.push({ a: 6, b: 2 }, false);

    const withoutReplace = crossover();
    withoutReplace.push({ a: 5, b: 2 }, false); // the same final value, pushed straight
    const withoutReplaceResult = withoutReplace.push({ a: 6, b: 2 }, false);

    expect(withReplaceResult).toBe(withoutReplaceResult);
    expect(withReplaceResult).toBe(false);
  });
});
