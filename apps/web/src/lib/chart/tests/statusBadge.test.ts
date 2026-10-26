import { describe, expect, it } from "vitest";
import { STATUS_BADGE_SLOT, drawStatusBadge, statusBadgeBox, type StatusBadgeSlot } from "../statusBadge";

describe("status badges in the chart's top-left corner (PR #34 review)", () => {
  it("gives every producer its own row, so no two badges can overlap whichever are shown", () => {
    const slots = Object.values(STATUS_BADGE_SLOT) as StatusBadgeSlot[];
    expect(new Set(slots).size).toBe(slots.length);
    const boxes = slots.map((slot) => statusBadgeBox(slot, "BOOKMAP PARTIAL · CELL CAP"));
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const [a, b] = [boxes[i], boxes[j]];
        expect(a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
      }
    }
  });

  it("sizes the box to its text and draws the text inside it", () => {
    const calls: unknown[][] = [];
    const context = { fillStyle: "" as unknown, fillRect: (...args: number[]) => calls.push(["rect", ...args]), fillText: (...args: unknown[]) => calls.push(["text", ...args]) };
    drawStatusBadge(context as never, STATUS_BADGE_SLOT.absorption, "Absorption · L2 feed untrusted");
    const [, x, y, width, height] = calls[0] as [string, number, number, number, number];
    const [, text, tx, ty] = calls[1] as [string, string, number, number];
    expect(text).toBe("Absorption · L2 feed untrusted");
    expect(tx).toBeGreaterThan(x);
    expect(ty).toBeGreaterThan(y);
    expect(ty).toBeLessThanOrEqual(y + height);
    expect(width).toBeGreaterThanOrEqual(text.length * 6.7);
    expect(statusBadgeBox(STATUS_BADGE_SLOT.absorption, "short").width).toBeLessThan(width);
  });
});
