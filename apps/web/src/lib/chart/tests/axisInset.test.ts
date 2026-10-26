import { describe, expect, it } from "vitest";
import { AXIS_INSET_GAP_PX, axisInsetPx } from "../axisInset";

describe("axisInsetPx", () => {
  it("is nothing while nothing is drawn against the axis", () => {
    expect(axisInsetPx([], 1_000)).toBe(0);
    expect(axisInsetPx([{ widthPx: () => 0 }], 1_000)).toBe(0);
  });

  it("is the widest indicator against the axis plus a gap, for this pane width", () => {
    expect(axisInsetPx([{ widthPx: (paneWidth) => paneWidth * 0.12 }], 1_000)).toBe(120 + AXIS_INSET_GAP_PX);
    expect(axisInsetPx([{ widthPx: () => 150 }, { widthPx: (paneWidth) => paneWidth * 0.12 }], 1_000)).toBe(150 + AXIS_INSET_GAP_PX);
    expect(axisInsetPx([{ widthPx: () => 150 }, { widthPx: (paneWidth) => paneWidth * 0.2 }], 1_000)).toBe(200 + AXIS_INSET_GAP_PX);
    expect(AXIS_INSET_GAP_PX).toBe(8);
  });
});
