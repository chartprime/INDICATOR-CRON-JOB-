import { describe, expect, it } from "vitest";
import {
  computeSwingVolumeBubbles,
  type SwingBubbleBar,
} from "../swingAlphabetProfileBubbles";

function legBar(
  time: number,
  volume: number,
  direction: "up" | "down" = "up",
): SwingBubbleBar {
  return {
    time,
    open: direction === "up" ? 100 : 110,
    high: 112,
    low: 98,
    close: direction === "up" ? 110 : 100,
    volume,
  };
}

describe("computeSwingVolumeBubbles", () => {
  it("drops bars below the configured share of the leg's peak volume", () => {
    const bubbles = computeSwingVolumeBubbles(
      [legBar(0, 100), legBar(1, 40), legBar(2, 60)],
      "#26a69a",
      "#ef5350",
      50,
    );
    expect(bubbles.map((bubble) => bubble.time)).toEqual([0, 2]);
  });

  it("honors a raised threshold", () => {
    const bubbles = computeSwingVolumeBubbles(
      [legBar(0, 100), legBar(1, 60), legBar(2, 80)],
      "#26a69a",
      "#ef5350",
      75,
    );
    expect(bubbles.map((bubble) => bubble.time)).toEqual([0, 2]);
  });

  it("scales size and label by the volume share of the leg peak", () => {
    const bubbles = computeSwingVolumeBubbles(
      [legBar(0, 100), legBar(1, 80), legBar(2, 65), legBar(3, 55)],
      "#26a69a",
      "#ef5350",
      50,
    );
    expect(bubbles.map((bubble) => bubble.text)).toEqual(["10", "8", "6", "5"]);
    expect(bubbles.map((bubble) => bubble.sizePx)).toEqual([50, 40, 30, 30]);
    expect(bubbles.map((bubble) => bubble.textSizePx)).toEqual([
      20, 16, 12, 12,
    ]);
  });

  it("colors by bar direction and fades alpha with the volume share", () => {
    const [bull, bear] = computeSwingVolumeBubbles(
      [legBar(0, 100, "up"), legBar(1, 50, "down")],
      "#26a69a",
      "#ef5350",
      50,
    );
    expect(bull.color).toBe("rgba(38, 166, 154, 1)");
    expect(bear.color).toBe("rgba(239, 83, 80, 0.5)");
  });

  it("prices bubbles at hlc3", () => {
    const [bubble] = computeSwingVolumeBubbles(
      [legBar(0, 10)],
      "#000000",
      "#000000",
      50,
    );
    expect(bubble.price).toBeCloseTo((112 + 98 + 110) / 3);
  });

  it("returns nothing when the leg has no volume", () => {
    expect(
      computeSwingVolumeBubbles([legBar(0, 0)], "#26a69a", "#ef5350", 50),
    ).toEqual([]);
  });
});
