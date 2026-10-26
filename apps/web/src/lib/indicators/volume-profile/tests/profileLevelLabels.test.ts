import { describe, expect, it } from "vitest";
import { binValueTextColor, formatLabelDelta, formatLabelVolume } from "../profileLevelLabels";

/** The WCAG relative luminance, computed the long way, as the reference the cached ink must match. */
function luminance([r, g, b]: readonly number[]): number {
  const linear = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: readonly number[], b: readonly number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function referenceInk(rgb: readonly number[]): string {
  return contrast([10, 10, 10], rgb) >= contrast([255, 255, 255], rgb) ? "#0a0a0a" : "#ffffff";
}

describe("profileLevelLabels", () => {
  it("formats whole bin values with thousands separators, the sign on a delta", () => {
    expect(formatLabelVolume(12_345.4)).toBe("12,345");
    expect(formatLabelDelta(1_234_567)).toBe("+1,234,567");
    expect(formatLabelDelta(-98_765.6)).toBe("-98,766");
    expect(formatLabelDelta(0.4)).toBe("0");
  });

  it("picks the same ink as the WCAG contrast formula for every opaque grey and a spread of colours", () => {
    const fills: number[][] = [];
    for (let v = 0; v <= 255; v += 1) fills.push([v, v, v]);
    for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) fills.push([r, g, b]);
    for (const rgb of fills) {
      expect(binValueTextColor(`rgb(${rgb.join(", ")})`)).toBe(referenceInk(rgb));
    }
  });
});
