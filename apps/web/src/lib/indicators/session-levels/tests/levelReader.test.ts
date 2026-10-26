import { describe, expect, it } from "vitest";
import { EATEN_SHARE, touches, wallRows } from "../levelReader";

describe("the wall at a level", () => {
  it("takes the asks at and above a high and the bids at and below a low, the band's rows wide", () => {
    expect(wallRows(100.5, "high", 1, 4)).toEqual([100, 103]);
    expect(wallRows(100.5, "low", 1, 4)).toEqual([97, 100]);
    expect(wallRows(100, "high", 0.5, 3)).toEqual([200, 202]);
  });

  it("counts a bar as reaching a level when its wick gets to the level's price", () => {
    expect(touches({ high: 100, low: 90 }, 100, "high")).toBe(true);
    expect(touches({ high: 99.9, low: 90 }, 100, "high")).toBe(false);
    expect(touches({ high: 110, low: 100 }, 100, "low")).toBe(true);
    expect(touches({ high: 110, low: 100.1 }, 100, "low")).toBe(false);
  });

  it("calls a wall eaten under half of what it held", () => {
    expect(EATEN_SHARE).toBe(0.5);
  });
});
