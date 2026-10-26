import { describe, expect, it } from "vitest";
import { SESSION_LEVEL_HIT_PX, hitSessionLevelHover, sessionLevelHoversFromUnknown } from "../sessionLevelHoverData";

const hover = { title: "London.H · London · 07:00–10:00 UTC", lines: ["Biggest buy order: 12.0 BTC"], price: 100, fromMs: 1_000, toMs: 5_000 };

describe("sessionLevelHoversFromUnknown", () => {
  it("keeps only well-formed hovers from whatever the runtime handed over", () => {
    expect(sessionLevelHoversFromUnknown(null)).toEqual([]);
    expect(sessionLevelHoversFromUnknown([hover, { ...hover, price: "100" }, { ...hover, lines: [1] }, { ...hover, toMs: 999 }, { ...hover, fromMs: Number.NaN }, 7])).toEqual([hover]);
  });
});

describe("hitSessionLevelHover", () => {
  const priceToCoordinate = (price: number) => (price === 100 ? 200 : null);

  it("hits within eight pixels of the line, from the line's first bar to the bar it ends on", () => {
    expect(hitSessionLevelHover(hover, { crosshairTimeMs: 3_000, cursorY: 205, intervalMs: 1_000, priceToCoordinate })).toEqual({ distance: 5, y: 200 });
    expect(hitSessionLevelHover(hover, { crosshairTimeMs: 1_000, cursorY: 200 - SESSION_LEVEL_HIT_PX, intervalMs: 1_000, priceToCoordinate })).toEqual({ distance: SESSION_LEVEL_HIT_PX, y: 200 });
    expect(hitSessionLevelHover(hover, { crosshairTimeMs: 5_999, cursorY: 200, intervalMs: 1_000, priceToCoordinate })).toEqual({ distance: 0, y: 200 });
    expect(hitSessionLevelHover(hover, { crosshairTimeMs: 3_000, cursorY: 209, intervalMs: 1_000, priceToCoordinate })).toBeNull();
    expect(hitSessionLevelHover(hover, { crosshairTimeMs: 999, cursorY: 200, intervalMs: 1_000, priceToCoordinate })).toBeNull();
    expect(hitSessionLevelHover(hover, { crosshairTimeMs: 6_000, cursorY: 200, intervalMs: 1_000, priceToCoordinate })).toBeNull();
    expect(hitSessionLevelHover({ ...hover, price: 50 }, { crosshairTimeMs: 3_000, cursorY: 200, intervalMs: 1_000, priceToCoordinate })).toBeNull();
  });
});
