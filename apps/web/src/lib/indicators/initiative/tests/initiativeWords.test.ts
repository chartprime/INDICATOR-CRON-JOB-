import { describe, expect, it } from "vitest";
import { percentText, pushersOf, strengthOf, timesText } from "../initiativeWords";

describe("initiative words", () => {
  it("an up leg is the buyers', a down leg the sellers'", () => {
    expect([pushersOf("up"), pushersOf("down")]).toEqual(["buyers", "sellers"]);
  });

  it("the score reads as a strength: weak up to 2, moderate at 3, strong at 4, very strong at 5", () => {
    expect([0, 1, 2, 3, 4, 5].map(strengthOf)).toEqual(["Weak", "Weak", "Weak", "Moderate", "Strong", "Very strong"]);
  });

  it("a share is a whole percent and a ratio one decimal with a times sign", () => {
    expect([percentText(0.714), percentText(0.495), percentText(1), percentText(0)]).toEqual(["71%", "50%", "100%", "0%"]);
    expect([timesText(2.6), timesText(1.6667), timesText(2)]).toEqual(["2.6×", "1.7×", "2.0×"]);
  });
});
