import { describe, expect, it } from "vitest";
import { ladderLabelGroups } from "../liquidityLadderRenderer";

describe("ladderLabelGroups", () => {
  const row = (yTop: number, yBottom: number, side: "bid" | "ask", size: number) => ({ yTop, yBottom, side, size });

  it("keeps one number per band while bands are tall enough", () => {
    const rows = [row(0, 20, "ask", 5), row(20, 40, "ask", 7), row(40, 60, "bid", 3)];
    expect(ladderLabelGroups(rows, 12)).toEqual([row(40, 60, "bid", 3), row(0, 20, "ask", 5), row(20, 40, "ask", 7)]);
  });

  it("stacks thin neighbouring bands of one side until the stack fits a number, summing their sizes", () => {
    const rows = [row(0, 4, "ask", 1), row(4, 8, "ask", 2), row(8, 12, "ask", 3), row(12, 16, "ask", 4), row(16, 20, "bid", 10), row(20, 24, "bid", 20)];
    expect(ladderLabelGroups(rows, 10)).toEqual([row(16, 24, "bid", 30), row(0, 12, "ask", 6), row(12, 16, "ask", 4)]);
  });

  it("never mixes sides, whatever their order", () => {
    const rows = [row(0, 4, "bid", 1), row(4, 8, "ask", 2), row(8, 12, "bid", 3)];
    expect(ladderLabelGroups(rows, 10)).toEqual([row(0, 12, "bid", 4), row(4, 8, "ask", 2)]);
  });
});
