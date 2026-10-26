import { describe, expect, it } from "vitest";
import { ageText, describeVoid, keptPerSide, smallestInFront, tradedLittle, type VoidBox } from "../liquidityVoidsRender";

function box(side: "bid" | "ask", rowLo: number, rowHi: number, endTs = 0, volume = 0): VoidBox {
  return { side, rowLo, rowHi, startTs: endTs - 30_000, endTs, volume };
}

describe("liquidity voids render helpers", () => {
  it("hides the boxes traded above the maximum and the ones whose volume is still to come, and keeps a box whose volume can never come because the chart dropped its columns", () => {
    const boxes = [box("ask", 1, 2, 0, 10), box("ask", 3, 4, 0, 30), box("ask", 5, 6, 0, 31), { ...box("bid", 7, 8, 0), volume: null }, { ...box("bid", 9, 10, 100_000), volume: null }];
    expect(tradedLittle(boxes, 30, -Infinity).map((b) => b.rowLo)).toEqual([1, 3]);
    expect(tradedLittle(boxes, 30, 0).map((b) => b.rowLo)).toEqual([1, 3, 7]);
    expect(tradedLittle(boxes, 30, 70_000).map((b) => b.rowLo)).toEqual([1, 3, 7]);
    expect(tradedLittle(boxes, null, -Infinity).map((b) => b.rowLo)).toEqual([1, 3, 5, 7, 9]);
  });

  it("orders overlapping boxes so the one with the smallest traded volume is drawn last, in front; unknown volume goes to the back", () => {
    const boxes = [box("ask", 1, 2, 0, 12), { ...box("ask", 1, 3, 0), volume: null }, box("bid", 1, 2, 0, 2), box("ask", 2, 3, 0, 40)];
    expect(smallestInFront(boxes).map((b) => b.volume)).toEqual([null, 40, 12, 2]);
  });

  it("keeps the nearest boxes per side up to the cap", () => {
    const boxes = [box("ask", 120, 125), box("ask", 105, 108), box("ask", 140, 150), box("bid", 80, 90), box("bid", 60, 70)];
    const kept = keptPerSide(boxes, 2, 100, "nearest");
    expect(kept.map((b) => `${b.side}:${b.rowLo}`)).toEqual(["bid:80", "bid:60", "ask:105", "ask:120"]);
    expect(keptPerSide(boxes, 1, 100, "nearest").map((b) => `${b.side}:${b.rowLo}`)).toEqual(["bid:80", "ask:105"]);
  });

  it("keeps the outer boxes of each side when the levels are kept furthest from price, the newest first among equals, and reads an unknown choice as nearest", () => {
    const boxes = [box("ask", 120, 125), box("ask", 105, 108), box("ask", 140, 150, 5), box("ask", 140, 150, 9), box("bid", 80, 90), box("bid", 60, 70)];
    expect(keptPerSide(boxes, 2, 100, "furthest").map((b) => `${b.side}:${b.rowLo}:${b.endTs}`)).toEqual(["bid:60:0", "bid:80:0", "ask:140:9", "ask:140:5"]);
    expect(keptPerSide(boxes, 1, 100, "furthest").map((b) => `${b.side}:${b.rowLo}`)).toEqual(["bid:60", "ask:140"]);
    expect(keptPerSide(boxes, 1, 100, "sideways" as never).map((b) => `${b.side}:${b.rowLo}`)).toEqual(["bid:80", "ask:105"]);
  });

  it("writes the chip as the side and the age only, the side alone to fall back on: the move and the volume stay off it", () => {
    expect(describeVoid(box("ask", 1001, 1012, 1_000_000, 3.2), 1_000_000 + 8 * 60_000)).toEqual(["FPB Ask · 8m", "FPB Ask"]);
    expect(describeVoid(box("bid", 10, 47, 0, 41), 0)).toEqual(["FPB Bid · 0m", "FPB Bid"]);
    expect(describeVoid({ ...box("bid", 1001, 1023, 1_000_000), volume: null }, 1_000_000 + 3 * 60_000)).toEqual(["FPB Bid · 3m", "FPB Bid"]);
    expect(describeVoid(box("ask", 1, 3, 0, 200), 125 * 60_000)).toEqual(["FPB Ask · 2h 5m", "FPB Ask"]);
    // The age counts from the push's end, not its start.
    expect(describeVoid({ ...box("ask", 1, 3, 0, 200), startTs: -7_200_000 }, 125 * 60_000)).toEqual(["FPB Ask · 2h 5m", "FPB Ask"]);
    for (const text of describeVoid(box("ask", 1001, 1012, 1_000_000, 3.2), 1_000_000)) expect(text).not.toMatch(/[$]|bought|sold|ticks/);
  });

  it("shows ages in minutes under an hour, then hours and minutes", () => {
    expect(ageText(59 * 60_000)).toBe("59m");
    expect(ageText(125 * 60_000)).toBe("2h 5m");
    expect(ageText(-5_000)).toBe("0m");
  });
});
