import { describe, expect, it } from "vitest";
import type { ExhaustionShade } from "../../../../types/frames";
import { MAX_SCORE, SCORE_ACCURACY, describeExhaustion, scoreAccuracy, scoreLabel, statusWords } from "../exhaustionHover";

const T = Date.UTC(2026, 9, 10, 13, 40);

function shade(over: Partial<ExhaustionShade> = {}): ExhaustionShade {
  return {
    id: "s", candleMs: 300000, side: "buyers", status: "held", intensity: 2, score: 5,
    readings: { rate: true, progress: true, delta: false, divergence: true, prints: true, book: true },
    values: { rate: 0.211, progress: 0.05, delta: 0.12, divergence: -0.88, prints: null, book: 0.5 },
    raw: { own: 3, other: 7, legOwn: 14.222, moved: 0, legMoved: 1.778, big: 0, legBig: 0, extremeOwn: 20, extremeOther: 0, bookNow: 1, bookAt: 2, bookBand: 0 },
    startTs: T, endTs: T + 600_000, extremeTs: T - 300_000, extremePrice: 82786, legStartTs: T - 3_000_000, legStartPrice: 82482,
    legSize: 304, efficiency: 0.88, atr: 32, judgedAt: T + 1_500_000, updatedAt: T + 1_500_000, origin: "runtime", ...over,
  };
}

const rows = (lines: ReturnType<typeof describeExhaustion>["lines"]) => lines.map((line) => [line.label, line.value, line.detail, line.counted]);

describe("describeExhaustion", () => {
  it("the hover is the side and the score; the card's first line adds the measured accuracy and the verdict", () => {
    const hover = describeExhaustion(shade());
    expect(hover).toMatchObject({ id: "s", side: "buyers", short: "Buyers exhausted · 5/6", title: "Buyers exhausted · 5/6 · ~60% · held" });
    expect(Object.keys(hover).sort()).toEqual(["id", "lines", "short", "side", "title"]);
  });

  it("the card's lines are the six readings as numbers, one each, in the engine's order: the amount now, the leg's or the extreme's under it, marked by whether each counted toward the score", () => {
    expect(rows(describeExhaustion(shade(), true, "BTC").lines)).toEqual([
      ["Buying volume", "3.00 BTC", "Leg: 14.2", true],
      ["Price moved", "Now: 0.00 / 3.00", "Leg: 1.78 / 14.2", true],
      ["Delta", "Buys: 3.00", "Sells: 7.00", false],
      ["Vs the high", "Now: −4.00 (−40%)", "High: +20.0 (+100%)", true],
      ["Big buyers", "Now: 0", "Leg: 0", true],
      ["Book at the high", "Asks: 1.00", "High: 2.00", true],
    ]);
    expect(describeExhaustion(shade()).lines.map((line) => line.key)).toEqual(["rate", "progress", "delta", "divergence", "prints", "book"]);
  });

  it("a fall names the sellers, the low and the bids, reads buys first in the delta, counts contracts whole, and shows a dash for what the engine could not read", () => {
    const fall = describeExhaustion(shade({ side: "sellers", status: "broke", score: 3, readings: { rate: true, progress: false, delta: true, divergence: false, prints: true, book: false }, raw: { own: 3, other: 7, legOwn: 14.222, moved: -2.5, legMoved: 1.778, big: 2, legBig: 0.5, extremeOwn: 20, extremeOther: 0, bookNow: 1, bookAt: 2, bookBand: 0 } }), true, "contracts");
    expect(fall.short).toBe("Sellers exhausted · 3/6");
    expect(fall.title).toBe("Sellers exhausted · 3/6 · ~57% · broke through");
    expect(rows(fall.lines)).toEqual([
      ["Selling volume", "3 contracts", "Leg: 14", true],
      ["Price moved", "Now: −2.50 / 3", "Leg: 1.78 / 14", false],
      ["Delta", "Buys: 7", "Sells: 3", true],
      ["Vs the low", "Now: +4 (+40%)", "Low: −20 (−100%)", false],
      ["Big sellers", "Now: 2", "Leg: 0.5", true],
      ["Book at the low", "Bids: 1", "Low: 2", false],
    ]);
    const blank = describeExhaustion(shade({ raw: { own: null, other: null, legOwn: null, moved: null, legMoved: null, big: null, legBig: null, extremeOwn: null, extremeOther: null, bookNow: null, bookAt: null, bookBand: null } }), true, "BTC");
    expect(blank.lines.map((line) => [line.value, line.detail])).toEqual([["—", "Leg: —"], ["Now: — / —", "Leg: — / —"], ["Buys: —", "Sells: —"], ["Now: —", "High: —"], ["Now: —", "Leg: —"], ["Now: —", "High: —"]]);
    const noExtreme = describeExhaustion(shade({ raw: { own: 3, other: 7, legOwn: 14.222, moved: 0, legMoved: 1.778, big: 0, legBig: 4, extremeOwn: null, extremeOther: null, bookNow: null, bookAt: null, bookBand: null } }), true, "BTC");
    expect(noExtreme.lines.slice(3).map((line) => [line.value, line.detail])).toEqual([["Now: −4.00 (−40%)", "High: —"], ["Now: 0", "Leg: 4"], ["Now: —", "High: —"]]);
    const plain = describeExhaustion(shade());
    expect(plain.lines.slice(0, 2).map((line) => [line.value, line.detail])).toEqual([["3.00", "Leg: 14.2"], ["Now: 0.00 / 3.00", "Leg: 1.78 / 14.2"]]);
  });

  it("the accuracy is the share of shades whose leg came back before a break, measured per score on 1m; a score outside the ladder has none", () => {
    expect(MAX_SCORE).toBe(6);
    expect(SCORE_ACCURACY).toEqual({ 3: 57, 4: 54, 5: 60, 6: 69 });
    expect([2, 3, 4, 5, 6, 7].map(scoreAccuracy)).toEqual([null, 57, 54, 60, 69, null]);
    expect([3, 4, 5, 6].map((score) => scoreLabel({ score }))).toEqual(["3/6 · ~57%", "4/6 · ~54%", "5/6 · ~60%", "6/6 · ~69%"]);
    expect(scoreLabel({ score: 2 })).toBe("2/6");
  });

  it("away from the default leg sliders the accuracy is not shown, since it was measured there", () => {
    expect(scoreLabel({ score: 5 }, false)).toBe("5/6");
    expect(describeExhaustion(shade(), false).title).toBe("Buyers exhausted · 5/6 · held");
    expect(describeExhaustion(shade(), false).short).toBe("Buyers exhausted · 5/6");
  });

  it("every status has words", () => {
    expect(["open", "pending", "held", "broke", "interrupted"].map((status) => statusWords(status as ExhaustionShade["status"]))).toEqual(["live", "waiting for the verdict", "held", "broke through", "session break"]);
  });
});
