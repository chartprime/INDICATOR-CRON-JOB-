import { describe, expect, it } from "vitest";
import { formatUsd } from "../formatUsd";

describe("formatUsd", () => {
  it("formats sub-thousand values as a plain rounded dollar amount", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(1)).toBe("$1");
    expect(formatUsd(999)).toBe("$999");
    expect(formatUsd(150.4)).toBe("$150");
  });

  it("formats thousands with one decimal and a 'k' suffix", () => {
    expect(formatUsd(1_000)).toBe("$1.0k");
    expect(formatUsd(12_450)).toBe("$12.4k");
    expect(formatUsd(999_499)).toBe("$999.5k");
  });

  it("formats millions with two decimals and an 'M' suffix", () => {
    expect(formatUsd(1_000_000)).toBe("$1.00M");
    expect(formatUsd(1_023_000)).toBe("$1.02M");
    expect(formatUsd(45_678_000)).toBe("$45.68M");
  });

  it("promotes values whose displayed rounding reaches the next tier", () => {
    expect(formatUsd(999.49)).toBe("$999");
    expect(formatUsd(999.99)).toBe("$1.0k");
    expect(formatUsd(999_999.99)).toBe("$1.00M");
    expect(formatUsd(1_000_000)).toBe("$1.00M");
  });

  it("keeps large DOM notionals readable through billions and trillions", () => {
    expect(formatUsd(12_345_678_900)).toBe("$12.35B");
    expect(formatUsd(99_999_999_999_999)).toBe("$100.00T");
  });

  it("does not render malformed numeric input as a fake dollar amount", () => {
    expect(formatUsd(Number.NaN)).toBe("—");
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatUsd(-1_500)).toBe("-$1.5k");
  });
});
