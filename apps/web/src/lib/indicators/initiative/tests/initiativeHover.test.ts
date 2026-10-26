import { describe, expect, it } from "vitest";
import type { InitiativeBand, InitiativeFacts } from "../../../../types/frames";
import { INITIATIVE_LINE_KEYS, describeInitiative, scoreLabel } from "../initiativeHover";

const T = Date.UTC(2026, 9, 14, 13, 40);

function band(over: Partial<InitiativeBand> = {}): InitiativeBand {
  return {
    id: "b", candleMs: 300000, side: "up", dominant: "buyers", dominantShare: 0.71, score: 4,
    facts: { efficiency: { yes: true, value: 0.82 }, closes: { yes: true, value: 3 }, burst: { yes: true, value: 2.6 }, delta: { yes: true, rank: 0.88, share: 0.71 }, prints: { yes: false, rank: 0.65, perCandle: 1.5 } },
    pivotTs: T, pivotPrice: 82482, frozenTs: T + 900_000, frozenPrice: 82600, windowCandles: 4, atr: 32,
    legExtremePrice: 82584.4, legExtremeTs: T + 1_200_000, legEndTs: null, updatedAt: T + 1_200_000, origin: "runtime", ...over,
  };
}

const rows = (lines: ReturnType<typeof describeInitiative>["lines"]) => lines.map((line) => [line.label, line.value, line.counted]);

const missed: InitiativeFacts = { efficiency: { yes: false, value: 0.5 }, closes: { yes: false, value: 1 }, burst: { yes: false, value: 1.6 }, delta: { yes: false, rank: 0.4, share: 0.48 }, prints: { yes: false, rank: 0.3, perCandle: 0.5 } };

describe("describeInitiative", () => {
  it("the hover line and the card's title are the side's start, the strength word and the score out of five; the pushers follow the leg", () => {
    const hover = describeInitiative(band());
    expect(hover).toMatchObject({ id: "b", side: "up", pushers: "buyers", short: "Buy start · Strong (4 of 5)", title: "▲ BUY START · STRONG (4 of 5)" });
    expect(Object.keys(hover).sort()).toEqual(["id", "lines", "pushers", "short", "side", "title"]);
    const fall = describeInitiative(band({ side: "down", dominant: "buyers", score: 5 }));
    expect([fall.short, fall.title, fall.pushers]).toEqual(["Sell start · Very strong (5 of 5)", "▼ SELL START · VERY STRONG (5 of 5)", "sellers"]);
    expect(describeInitiative(band({ score: 2 })).title).toBe("▲ BUY START · WEAK (2 of 5)");
    expect(INITIATIVE_LINE_KEYS).toEqual(["efficiency", "closes", "burst", "delta", "prints"]);
  });

  it("the card's lines are the five facts in plain words, in the engine's order, each marked by whether it counted", () => {
    expect(rows(describeInitiative(band()).lines)).toEqual([
      ["Clean move", "price went mostly one way", true],
      ["Strong candles", "3 of 4 closed near the high", true],
      ["Volume burst", "volume 2.6× the quiet before", true],
      ["Buyers in charge", "71% of orders were buys, unusually high", true],
      ["Big buyers", "large buy trades at a usual pace", false],
    ]);
    expect(describeInitiative(band()).lines.map((line) => line.key)).toEqual(["efficiency", "closes", "burst", "delta", "prints"]);
  });

  it("a down leg speaks of sellers, lows and sells; a fact that fell short says by how much", () => {
    expect(rows(describeInitiative(band({ side: "down", facts: missed, score: 0 })).lines)).toEqual([
      ["Clean move", "price went back and forth", false],
      ["Strong candles", "only 1 of 4 closed near the low", false],
      ["Volume burst", "volume only 1.6× the quiet before", false],
      ["Sellers in charge", "48% of orders were sells, not unusual", false],
      ["Big sellers", "large sell trades at a usual pace", false],
    ]);
    const none = describeInitiative(band({ side: "down", facts: { ...missed, closes: { yes: false, value: 0 }, prints: { yes: false, rank: 0, perCandle: 0 } }, score: 0 }));
    expect(none.lines.map((line) => line.value)).toEqual(["price went back and forth", "none of 4 closed near the low", "volume only 1.6× the quiet before", "48% of orders were sells, not unusual", "no large sell trades"]);
    const strongDown = describeInitiative(band({ side: "down", facts: { ...band().facts, prints: { yes: true, rank: 0.9, perCandle: 2 } }, score: 5 }));
    expect(strongDown.lines.map((line) => line.value)).toEqual(["price went mostly one way", "3 of 4 closed near the low", "volume 2.6× the quiet before", "71% of orders were sells, unusually high", "more large sell trades than usual"]);
  });

  it("a fact the engine could not read says so in words", () => {
    const blank = describeInitiative(band({ facts: { efficiency: { yes: false, value: null }, closes: { yes: false, value: 0 }, burst: { yes: false, value: null }, delta: { yes: false, rank: null, share: null }, prints: { yes: false, rank: null, perCandle: null } }, score: 0 }));
    expect(blank.lines.map((line) => line.value)).toEqual(["price barely moved", "none of 4 closed near the high", "volume not measured", "orders not measured", "large trades not measured"]);
  });

  it("the score label reads the score over five", () => {
    expect([scoreLabel({ score: 4 }), scoreLabel({ score: 0 })]).toEqual(["4/5", "0/5"]);
  });
});
