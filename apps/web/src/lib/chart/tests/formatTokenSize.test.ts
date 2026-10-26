import { describe, expect, it } from "vitest";
import { formatTokenSize } from "../formatTokenSize";

describe("formatTokenSize", () => {
  it("formats zero", () => {
    expect(formatTokenSize(0)).toBe("0");
  });

  it("formats sub-1 values to 1 decimal, trailing zero stripped", () => {
    expect(formatTokenSize(0.5)).toBe("0.5");
    expect(formatTokenSize(0.05)).toBe("0.1");
    expect(formatTokenSize(0.005)).toBe("0");
  });

  it("formats values 1-999 to 1 decimal, trailing zero stripped", () => {
    expect(formatTokenSize(2)).toBe("2");
    expect(formatTokenSize(2.4)).toBe("2.4");
    expect(formatTokenSize(12.756)).toBe("12.8");
  });

  it("switches to a k suffix at 1000", () => {
    expect(formatTokenSize(1000)).toBe("1.0k");
    expect(formatTokenSize(1500)).toBe("1.5k");
    expect(formatTokenSize(999)).toBe("999");
  });

  it("switches to an M suffix at 1,000,000", () => {
    expect(formatTokenSize(1_234_567)).toBe("1.2M");
  });

  it("promotes rounded boundary values instead of emitting misleading 1000-sized labels", () => {
    expect(formatTokenSize(999.95)).toBe("1.0k");
    expect(formatTokenSize(999_950)).toBe("1.0M");
    expect(formatTokenSize(999_950_000)).toBe("1.0B");
  });

  it("switches to a B suffix at 1,000,000,000", () => {
    expect(formatTokenSize(2_500_000_000)).toBe("2.5B");
  });

  it("keeps values beyond billions compact", () => {
    expect(formatTokenSize(2_500_000_000_000)).toBe("2.5T");
  });

  it("preserves the sign for a negative value", () => {
    expect(formatTokenSize(-2.4)).toBe("-2.4");
    expect(formatTokenSize(-1500)).toBe("-1.5k");
  });

  it("returns an em dash for a non-finite value rather than throwing or printing NaN", () => {
    expect(formatTokenSize(NaN)).toBe("—");
    expect(formatTokenSize(Infinity)).toBe("—");
  });

  it("rounds to 0 decimals when asked, for a shorter fallback label", () => {
    expect(formatTokenSize(95.1, 0)).toBe("95");
    expect(formatTokenSize(83.8, 0)).toBe("84");
    expect(formatTokenSize(1_500, 0)).toBe("2k");
    expect(formatTokenSize(133, 0)).toBe("133");
  });

  it("keeps the same tier/suffix choice at 0 decimals as at the default precision -- only the digit count changes", () => {
    expect(formatTokenSize(999_950, 0)).toBe("1M");
  });

  it("REGRESSION: promotes at 0 decimals even when the value only rounds to 1000 at that precision, not at the default 1-decimal precision", () => {
    // 999_600 / 1000 = 999.6 -- toFixed(1) shows "999.6" (< 1000, no
    // promotion under the old hardcoded check), but toFixed(0) shows
    // "1000" (the digit count actually being rendered). The promotion
    // decision must use the same rounding as the final display.
    expect(formatTokenSize(999_600, 0)).toBe("1M");
    expect(formatTokenSize(999_600)).toBe("999.6k");
  });
});
