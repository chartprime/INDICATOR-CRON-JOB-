import { describe, expect, it } from "vitest";
import { reachShareForWidth } from "../axisProfileLayout";

describe("reachShareForWidth", () => {
  it("moves the reach by the difference between the width asked for and the width taken, inside the bounds", () => {
    expect(reachShareForWidth(120, 271, 301, 1_000, 0.05, 0.6)).toBeCloseTo(0.15, 10);
    expect(reachShareForWidth(120, 271, 171, 1_000, 0.05, 0.6)).toBe(0.05);
    expect(reachShareForWidth(120, 271, 231, 1_000, 0.05, 0.6)).toBeCloseTo(0.08, 10);
    expect(reachShareForWidth(120, 271, 2_000, 1_000, 0.05, 0.6)).toBe(0.6);
    expect(reachShareForWidth(120, 271, 301, 0, 0.05, 0.6)).toBe(0.05);
  });
});
