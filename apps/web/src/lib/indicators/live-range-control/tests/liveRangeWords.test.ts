import { describe, expect, it } from "vitest";
import type { LiveRangeRead } from "../liveRangeReader";
import type { PrintRead } from "../liveRangePrints";
import { originOf } from "../liveRangeWindow";
import { VERDICT_Z_FROM } from "../liveRangeSettings";
import {
  HEAD_TEXT,
  IMPACT_EVEN_RATIO,
  LEGEND_TEXT,
  MISSING_SAID_FROM,
  NO_TRADES_TEXT,
  VERDICT_HELD_FROM,
  VERDICT_MIN_MINUTES,
  VERDICT_TEXT,
  WAITING_TEXT,
  amountText,
  headText,
  impactText,
  impactTip,
  impactUnderText,
  legendText,
  minutesText,
  netText,
  pointsText,
  printCountText,
  printText,
  rangeLine,
  rangeNote,
  rangeRows,
  sinceLabel,
  sizeText,
  spanLabel,
  spanText,
  toneOf,
  verdictOf,
  windowLabel,
  windowText,
  zOf,
  zText,
} from "../liveRangeWords";

const T = Date.UTC(2026, 9, 16, 2, 35, 20);
const NOW = Date.UTC(2026, 9, 17, 2, 35, 20);
const MINUTE = 60_000;

function read(patch: Partial<LiveRangeRead> = {}): LiveRangeRead {
  return { buys: 1_204.4, sells: 0.3, fromTs: T, toTs: T + 30 * MINUTE, coveredMs: 30 * MINUTE, tradedMs: 30 * MINUTE, missing: [], noise: 600, minutesWon: { buyers: 18, sellers: 34 }, impact: { buyers: { moved: 12.4, volume: 6_500 }, sellers: { moved: 48, volume: 6_400 } }, ...patch };
}

const PRINTS: PrintRead = { buys: 34.2, sells: 12, buyCount: 5, sellCount: 2, threshold: 5, floor: 0.39, unit: "BTC" };

describe("sizes and amounts", () => {
  it("writes a size to three figures, with k and M, <1 for a trace and 0 for nothing", () => {
    expect([sizeText(0), sizeText(0.3), sizeText(7), sizeText(999.4), sizeText(1_204.4), sizeText(12_345), sizeText(999_500), sizeText(2_345_678)]).toEqual(["0", "<1", "7", "999", "1.2k", "12k", "1M", "2.3M"]);
    expect([netText(400), netText(-340), netText(0), netText(-0.2), netText(1_204)]).toEqual(["+400", "−340", "0", "−<1", "+1.2k"]);
    expect([sizeText(0.6), sizeText(1_000), sizeText(12_600), sizeText(998_600)]).toEqual(["1", "1k", "13k", "999k"]);
    expect(spanText(T, T + 29.6 * MINUTE)).toBe("30 min");
  });

  it("writes a threshold or a floor as it is set: two decimals at most at any size, with a thousands comma", () => {
    expect([amountText(0.5), amountText(2.5), amountText(5), amountText(0.125), amountText(9.994), amountText(10), amountText(12.5), amountText(49.5), amountText(300)]).toEqual(["0.5", "2.5", "5", "0.13", "9.99", "10", "12.5", "49.5", "300"]);
    expect([amountText(999.6), amountText(1_210), amountText(1_234.5), amountText(5_000), amountText(50_000)]).toEqual(["999.6", "1,210", "1,234.5", "5,000", "50,000"]);
  });
});

describe("spans and windows", () => {
  it("writes every day and time in UTC whatever zone the browser runs in, and names the first day whenever the two ends are not the same day, a month or a year apart included", () => {
    const zone = process.env.TZ;
    process.env.TZ = "Asia/Kolkata";
    try {
      expect(spanLabel(Date.UTC(2026, 9, 16, 23, 50), Date.UTC(2026, 9, 17, 0, 10))).toBe("16 Oct 23:50 → 00:10 UTC · 20 min");
      expect(spanLabel(Date.UTC(2026, 9, 31, 23, 50), Date.UTC(2026, 10, 1, 0, 10))).toBe("31 Oct 23:50 → 00:10 UTC · 20 min");
      expect(spanLabel(Date.UTC(2026, 9, 16, 18, 0), Date.UTC(2026, 9, 16, 19, 0))).toBe("18:00 → 19:00 UTC · 60 min");
      expect(spanLabel(Date.UTC(2026, 9, 31, 18, 0), Date.UTC(2026, 9, 31, 19, 0))).toBe("18:00 → 19:00 UTC · 60 min");
      expect(spanLabel(Date.UTC(2026, 11, 31, 18, 0), Date.UTC(2026, 11, 31, 19, 0))).toBe("18:00 → 19:00 UTC · 60 min");
      expect(spanLabel(Date.UTC(2026, 11, 1, 23, 50), Date.UTC(2026, 11, 2, 0, 10))).toBe("1 Dec 23:50 → 00:10 UTC · 20 min");
      expect(spanLabel(Date.UTC(2026, 10, 1, 23, 50), Date.UTC(2026, 10, 2, 0, 10))).toBe("1 Nov 23:50 → 00:10 UTC · 20 min");
      expect(spanLabel(Date.UTC(2026, 8, 16, 12, 0), Date.UTC(2026, 9, 16, 12, 0))).toBe("16 Sep 12:00 → 12:00 UTC · 30 d");
      expect(spanLabel(Date.UTC(2025, 9, 16, 12, 0), Date.UTC(2026, 9, 16, 12, 0))).toBe("16 Oct 12:00 → 12:00 UTC · 365 d");
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  it("names the span on screen: the clock at both ends on one day, the date on the first when they differ, and its length in minutes, hours or days", () => {
    expect(spanLabel(T, T + 30 * MINUTE)).toBe("02:35 → 03:05 UTC · 30 min");
    expect(spanLabel(T, T + 119 * MINUTE)).toBe("02:35 → 04:34 UTC · 119 min");
    expect(spanLabel(T, T + 151 * MINUTE)).toBe("02:35 → 05:06 UTC · 2.5 h");
    expect(spanLabel(Date.UTC(2026, 9, 15, 22, 26), Date.UTC(2026, 9, 16, 10, 12))).toBe("15 Oct 22:26 → 10:12 UTC · 11.8 h");
    expect(spanLabel(Date.UTC(2026, 9, 13, 22, 26), Date.UTC(2026, 9, 16, 10, 12))).toBe("13 Oct 22:26 → 10:12 UTC · 2.5 d");
    expect([spanText(T, T + 20_000), spanText(T, T + MINUTE), spanText(T, T + 48 * 60 * MINUTE)]).toEqual(["<1 min", "1 min", "2 d"]);
  });

  it("names a window: since its start while it follows the clock, both ends once the end is fixed, and the date of a day that is not today", () => {
    expect(windowText(Date.UTC(2026, 9, 17, 1, 5), null, NOW)).toBe("since 01:05 UTC");
    expect(windowText(Date.UTC(2026, 9, 16, 22, 26), null, NOW)).toBe("since 16 Oct 22:26 UTC");
    expect(windowText(Date.UTC(2026, 9, 17, 1, 5), Date.UTC(2026, 9, 17, 2, 0), NOW)).toBe("01:05 → 02:00 UTC");
    expect(windowText(Date.UTC(2026, 9, 16, 20, 0), Date.UTC(2026, 9, 16, 22, 30), NOW)).toBe("16 Oct 20:00 → 22:30 UTC");
    expect(windowText(Date.UTC(2026, 9, 16, 22, 26), Date.UTC(2026, 9, 17, 1, 0), NOW)).toBe("16 Oct 22:26 → 17 Oct 01:00 UTC");
  });

  it("labels the window of the dialog inside the last seven days with its length, and a start older than them at their edge", () => {
    const origin = originOf(NOW);
    expect(windowLabel(origin, { fromMs: null, toMs: null }, NOW)).toBe("since 10 Oct 02:35 UTC · 7 d");
    expect(windowLabel(origin, { fromMs: Date.UTC(2026, 9, 17, 1, 35), toMs: null }, NOW)).toBe("since 01:35 UTC · 60 min");
    expect(windowLabel(origin, { fromMs: Date.UTC(2026, 9, 16, 20, 0), toMs: Date.UTC(2026, 9, 16, 22, 30) }, NOW)).toBe("16 Oct 20:00 → 22:30 UTC · 2.5 h");
    expect(windowLabel(origin, { fromMs: Date.UTC(2026, 9, 1), toMs: null }, NOW)).toBe("since 10 Oct 02:35 UTC · 7 d");
  });

  it("names a live range since its start with its length so far", () => {
    expect(sinceLabel(T, T + 30 * MINUTE)).toBe("since 02:35 UTC · 30 min");
    expect(sinceLabel(Date.UTC(2026, 9, 15, 22, 26), Date.UTC(2026, 9, 16, 10, 12))).toBe("since 15 Oct 22:26 UTC · 11.8 h");
  });
});

describe("the three modes", () => {
  it("heads the card with what it reads: on screen, the selected zone or the live zone", () => {
    expect(HEAD_TEXT).toEqual({ visible: "on screen", selected: "selected zone", live: "live zone" });
    expect(Object.isFrozen(HEAD_TEXT)).toBe(true);
    expect(headText("visible")).toBe("on screen");
    expect(headText("selected")).toBe("selected zone");
    expect(headText("live")).toBe("live zone");
  });

  it("names the range: the span on screen in the visible range, since its start while a zone follows the clock, both ends once its end is fixed", () => {
    expect(rangeLine("visible", T, T + 30 * MINUTE, false)).toBe("02:35 → 03:05 UTC · 30 min");
    expect(rangeLine("visible", T, T + 30 * MINUTE, true)).toBe("02:35 → 03:05 UTC · 30 min");
    expect(rangeLine("selected", T, T + 30 * MINUTE, false)).toBe("02:35 → 03:05 UTC · 30 min");
    expect(rangeLine("selected", T, T + 30 * MINUTE, true)).toBe("since 02:35 UTC · 30 min");
    expect(rangeLine("live", T, T + 30 * MINUTE, true)).toBe("since 02:35 UTC · 30 min");
  });

  it("writes the legend: the candles on screen in the visible range, the window in the zone modes", () => {
    expect(LEGEND_TEXT).toBe("the candles on screen");
    expect(legendText("visible", { fromMs: NOW - 60 * MINUTE, toMs: null }, NOW)).toBe("the candles on screen");
    expect(legendText("live", { fromMs: Date.UTC(2026, 9, 17, 1, 35), toMs: null }, NOW)).toBe("since 01:35 UTC");
    expect(legendText("selected", { fromMs: Date.UTC(2026, 9, 16, 20, 0), toMs: Date.UTC(2026, 9, 16, 22, 30) }, NOW)).toBe("16 Oct 20:00 → 22:30 UTC");
  });
});

describe("rows", () => {
  it("gives five rows with no sub-lines: the volume traded, one delta coloured by its side with no z, the big prints by side with their count apart, the minutes each side won, and the price impact, the price each side moved its way in the minutes it won with the points per thousand of its volume apart", () => {
    expect(rangeRows(read(), PRINTS)).toEqual([
      { key: "volume", label: "Traded volume", left: "1.2k", right: "<1" },
      { key: "delta", label: "Delta", left: "", right: "", joined: { text: "+1.2k", tone: "buyers" } },
      { key: "prints", label: "Big prints", left: "34", right: "12", counts: { left: "(5)", right: "(2)" } },
      { key: "minutes", label: "Minutes won", left: "18 min", right: "34 min" },
      { key: "impact", label: "Price impact", left: "+12", right: "−48", counts: { left: "(1.9/k)", right: "(7.5/k)" } },
    ]);
    expect(rangeRows(read()).map((row) => Object.hasOwn(row, "sub"))).toEqual([false, false, false, false, false]);
  });

  it("puts dashes on the prints until they are read, and on a side of the price impact with no minute won", () => {
    expect(rangeRows(read())[2]).toEqual({ key: "prints", label: "Big prints", left: "–", right: "–" });
    const quiet = read({ impact: { buyers: { moved: 0, volume: 0 }, sellers: { moved: -3, volume: 20 } } });
    expect(rangeRows(quiet)[4]).toEqual({ key: "impact", label: "Price impact", left: "–", right: "+3", counts: { left: "", right: "(−150/k)" } });
  });

  it("writes the minutes won as a count of minutes, and the price impact as the price moved in the side's direction with a sign, down for sellers, rounded like a size: one decimal under ten, whole to a thousand, k and M from there; under it the points per thousand of the side's volume, rounded the same", () => {
    expect(minutesText(0)).toBe("0 min");
    expect(minutesText(127)).toBe("127 min");
    expect(impactText({ moved: 12.4, volume: 6_500 }, "buyers")).toBe("+12");
    expect(impactText({ moved: 48, volume: 6_400 }, "sellers")).toBe("−48");
    expect(impactText({ moved: -2.456, volume: 10 }, "buyers")).toBe("−2.5");
    expect(impactText({ moved: -2.456, volume: 10 }, "sellers")).toBe("+2.5");
    expect(impactText({ moved: 0.04, volume: 10 }, "buyers")).toBe("0");
    expect(impactText({ moved: 1_253.95, volume: 10 }, "buyers")).toBe("+1.3k");
    expect(impactText({ moved: 294.32, volume: 10 }, "sellers")).toBe("−294");
    expect([pointsText(9.96), pointsText(10.4), pointsText(999.5), pointsText(1_250_000)]).toEqual(["10", "10", "1000", "1.3M"]);
    expect(impactText({ moved: 0, volume: 10 }, "buyers")).toBe("0");
    expect(impactText({ moved: 0, volume: 10 }, "sellers")).toBe("0");
    expect(impactText({ moved: 1_234.5, volume: 10 }, "buyers")).toBe("+1.2k");
    expect(impactText({ moved: 5, volume: 0 }, "buyers")).toBe("–");
    expect(impactUnderText({ moved: 12.4, volume: 6_500 })).toBe("(1.9/k)");
    expect(impactUnderText({ moved: -3, volume: 20 })).toBe("(−150/k)");
    expect(impactUnderText({ moved: -0.004, volume: 20 })).toBe("(−0.2/k)");
    expect(impactUnderText({ moved: 0.0004, volume: 20 })).toBe("(0/k)");
    expect(impactUnderText({ moved: 0, volume: 20 })).toBe("(0/k)");
    expect(impactUnderText({ moved: 2_942, volume: 10 })).toBe("(294k/k)");
    expect(impactUnderText({ moved: 5, volume: 0 })).toBe("");
  });

  it("explains a side's price impact in plain words: how far price went in the minutes it won, on how much size, per thousand of it, and what that says next to the other side", () => {
    const impact = read().impact;
    expect(IMPACT_EVEN_RATIO).toBe(1.25);
    expect(impactTip(impact, "buyers", "BTC")).toEqual({
      title: "Buyers · price impact",
      lines: ["Price went up 12 points in the minutes buyers won", "while buyers bought 6.5k BTC", "1.9 points up for every 1,000 BTC bought"],
      reading: "Buyers needed 3.9× more size than sellers to move price",
    });
    expect(impactTip(impact, "sellers", "BTC")).toEqual({
      title: "Sellers · price impact",
      lines: ["Price went down 48 points in the minutes sellers won", "while sellers sold 6.4k BTC", "7.5 points down for every 1,000 BTC sold"],
      reading: "Sellers moved price 3.9× more per unit than buyers",
    });
    expect(impactTip(impact, "buyers", "").lines).toEqual(["Price went up 12 points in the minutes buyers won", "while buyers bought 6.5k", "1.9 points up for every 1,000 bought"]);
    const absorbed = { buyers: { moved: -3, volume: 20 }, sellers: { moved: -5, volume: 40 } };
    expect(impactTip(absorbed, "buyers", "contracts")).toEqual({
      title: "Buyers · price impact",
      lines: ["Price went down 3 points in the minutes buyers won", "while buyers bought 20 contracts", "150 points down for every 1,000 contracts bought"],
      reading: "Buyers were absorbed: their buying did not lift price",
    });
    expect(impactTip(absorbed, "sellers", "contracts")).toEqual({
      title: "Sellers · price impact",
      lines: ["Price went up 5 points in the minutes sellers won", "while sellers sold 40 contracts", "125 points up for every 1,000 contracts sold"],
      reading: "Sellers were absorbed: their selling did not drop price",
    });
    expect(impactTip({ buyers: { moved: 0.01, volume: 10 }, sellers: impact.sellers }, "buyers", "BTC")).toEqual({
      title: "Buyers · price impact",
      lines: ["Price did not move in the minutes buyers won", "while buyers bought 10 BTC"],
      reading: "Buyers did not move price",
    });
    expect(impactTip({ buyers: impact.buyers, sellers: { moved: 0, volume: 0 } }, "buyers", "BTC").reading).toBe("Only buyers moved price their way");
    expect(impactTip({ buyers: impact.buyers, sellers: { moved: -2, volume: 30 } }, "buyers", "BTC").reading).toBe("Only buyers moved price their way");
    expect(impactTip({ buyers: impact.buyers, sellers: { moved: 0.01, volume: 30 } }, "buyers", "BTC").reading).toBe("Only buyers moved price their way");
    expect(impactTip({ buyers: { moved: 0, volume: 0 }, sellers: impact.sellers }, "buyers", "BTC")).toEqual({ title: "Buyers · price impact", lines: ["No minute won by buyers to measure yet"], reading: null });
    const even = (a: number, b: number) => impactTip({ buyers: { moved: a, volume: 100 }, sellers: { moved: b, volume: 100 } }, "buyers", "BTC").reading;
    expect(even(200, 100)).toBe("Buyers moved price 2× more per unit than sellers");
    expect(even(125, 100)).toBe("Buyers moved price 1.3× more per unit than sellers");
    expect(even(124, 100)).toBe("Buyers and sellers moved price about the same per unit");
    expect(even(100, 124)).toBe("Buyers and sellers moved price about the same per unit");
    expect(even(100, 125)).toBe("Buyers needed 1.3× more size than sellers to move price");
    expect(impactTip({ buyers: { moved: 100, volume: 100 }, sellers: { moved: 100, volume: 100 } }, "sellers", "BTC").reading).toBe("Buyers and sellers moved price about the same per unit");
  });

  it("writes the delta of sellers with a minus and their tone, and a delta of nothing as even", () => {
    expect(rangeRows(read({ buys: 100, sells: 1_000, noise: 400 }))[1].joined).toEqual({ text: "−900", tone: "sellers" });
    expect(rangeRows(read({ buys: 10, sells: 10, noise: 4 }))[1].joined).toEqual({ text: "0", tone: "even" });
  });

  it("writes the big prints of a side as their size, and their count apart in brackets, whole up to 9999 and in k and M from ten thousand", () => {
    expect(printText(PRINTS, "buy")).toBe("34");
    expect(printText(PRINTS, "sell")).toBe("12");
    expect(printText({ ...PRINTS, buys: 0, buyCount: 0 }, "buy")).toBe("0");
    expect(printText({ ...PRINTS, sells: 1_250, sellCount: 31 }, "sell")).toBe("1.3k");
    expect(printText(null, "buy")).toBe("–");
    expect(printCountText(PRINTS, "buy")).toBe("(5)");
    expect(printCountText(PRINTS, "sell")).toBe("(2)");
    expect(printCountText({ ...PRINTS, buyCount: 0 }, "buy")).toBe("(0)");
    expect(printCountText({ ...PRINTS, sellCount: 9_999 }, "sell")).toBe("(9999)");
    expect(printCountText({ ...PRINTS, sellCount: 10_000 }, "sell")).toBe("(10k)");
    expect(printCountText({ ...PRINTS, buyCount: 12_345 }, "buy")).toBe("(12k)");
    expect(printCountText({ ...PRINTS, buyCount: 1_234_567 }, "buy")).toBe("(1.2M)");
  });

  it("colours the delta by its side: buyers above zero, sellers below, even when it rounds to nothing", () => {
    expect([toneOf(400), toneOf(-340), toneOf(0), toneOf(0.2), toneOf(-0.2), toneOf(Number.NaN)]).toEqual(["buyers", "sellers", "even", "buyers", "sellers", "even"]);
  });

});

describe("the verdict and the notes", () => {
  it("calls the range from the z of the tape at the sensitivity it is given: any z above or below 0 at High, from ±1 at Normal, from ±2 at Strict, Balanced between and at a z of 0", () => {
    const at = (buys: number, sells: number, from: number) => verdictOf(read({ buys, sells, noise: 300 }), from)?.key;
    expect([at(1, 0, VERDICT_Z_FROM.high), at(0, 1, VERDICT_Z_FROM.high), at(10, 10, VERDICT_Z_FROM.high)]).toEqual(["buyers", "sellers", "balanced"]);
    expect(verdictOf(read({ buys: 10, sells: 10, noise: 0 }), VERDICT_Z_FROM.high)).toEqual({ key: "balanced", text: "Balanced", z: 0 });
    expect([at(300, 0, VERDICT_Z_FROM.normal), at(299, 0, VERDICT_Z_FROM.normal), at(0, 300, VERDICT_Z_FROM.normal), at(0, 299, VERDICT_Z_FROM.normal)]).toEqual(["buyers", "balanced", "sellers", "balanced"]);
    expect([at(600, 0, VERDICT_Z_FROM.strict), at(599, 0, VERDICT_Z_FROM.strict), at(0, 600, VERDICT_Z_FROM.strict), at(0, 599, VERDICT_Z_FROM.strict)]).toEqual(["buyers", "balanced", "sellers", "balanced"]);
    expect(verdictOf(read({ buys: 600, sells: 0, noise: 300 }), VERDICT_Z_FROM.strict)).toEqual({ key: "buyers", text: "Buyers in control", z: 2 });
    expect(verdictOf(read({ buys: 0, sells: 0, noise: 0 }), VERDICT_Z_FROM.high)).toBeNull();
  });

  it("calls the range from the z of the tape, the net over the noise of its minutes: buyers from +1, sellers from −1, balanced between, nothing without trades", () => {
    expect(VERDICT_Z_FROM.normal).toBe(1);
    expect(VERDICT_TEXT).toEqual({ buyers: "Buyers in control", sellers: "Sellers in control", balanced: "Balanced", few: "Too few minutes", unseen: "Not enough data" });
    expect(zOf({ buys: 300, sells: 0, noise: 180 })).toBeCloseTo(1.6667, 4);
    expect(zOf({ buys: 10, sells: 10, noise: 0 })).toBe(0);
    expect(verdictOf(read({ buys: 300, sells: 0, noise: 300 }))).toEqual({ key: "buyers", text: "Buyers in control", z: 1 });
    expect(verdictOf(read({ buys: 0, sells: 300, noise: 300 }))).toEqual({ key: "sellers", text: "Sellers in control", z: -1 });
    expect(verdictOf(read({ buys: 299, sells: 0, noise: 300 }))?.key).toBe("balanced");
    expect(verdictOf(read({ buys: 0, sells: 299, noise: 300 }))?.key).toBe("balanced");
    expect(verdictOf(read({ buys: 10, sells: 10, noise: 0 }))).toEqual({ key: "balanced", text: "Balanced", z: 0 });
    expect(verdictOf(read({ buys: 0, sells: 0, noise: 0 }))).toBeNull();
    expect(verdictOf(read({ coveredMs: 0 }))).toBeNull();
    expect(verdictOf(null)).toBeNull();
  });

  it("holds the verdict as Not enough data while half or more of the range's candle time has no data, and says Too few minutes under five minutes won by either side, neither with a z", () => {
    expect([VERDICT_HELD_FROM, VERDICT_MIN_MINUTES]).toEqual([0.5, 5]);
    const missing = (minutes: number) => read({ tradedMs: 60 * MINUTE, missing: [[T, T + minutes * MINUTE]] });
    expect(verdictOf(missing(30))).toEqual({ key: "unseen", text: "Not enough data", z: null });
    expect(verdictOf(missing(29.9))?.key).toBe("buyers");
    expect(verdictOf({ ...missing(30), minutesWon: { buyers: 1, sellers: 0 } })?.key).toBe("unseen");
    expect(verdictOf(read({ buys: 0, sells: 0, coveredMs: 0, tradedMs: 30 * MINUTE, missing: [[T, T + 30 * MINUTE]] }))?.key).toBe("unseen");
    expect(verdictOf(read({ tradedMs: 0, missing: [[T, T + MINUTE]] }))?.key).toBe("buyers");
    const won = (buyers: number, sellers: number) => verdictOf(read({ minutesWon: { buyers, sellers } }), VERDICT_Z_FROM.high);
    expect(won(4, 0)).toEqual({ key: "few", text: "Too few minutes", z: null });
    expect([won(2, 2)?.key, won(0, 4)?.key, won(5, 0)?.key, won(3, 2)?.key, won(0, 5)?.key]).toEqual(["few", "few", "buyers", "buyers", "buyers"]);
    expect(verdictOf(read({ buys: 0, sells: 0, minutesWon: { buyers: 0, sellers: 0 } }))).toBeNull();
  });

  it("writes z with a sign and one decimal, a minus sign only when the rounded value is below zero", () => {
    expect([zText(1.6667), zText(-1.84), zText(0), zText(-0.04), zText(0.05), zText(12.345)]).toEqual(["z +1.7", "z −1.8", "z +0.0", "z +0.0", "z +0.1", "z +12.3"]);
  });

  it("notes nothing while the hours of the range are still loading, whatever else is missing", () => {
    expect(rangeNote(read(), "visible", true)).toBeNull();
    expect(rangeNote(read({ buys: 0, sells: 0 }), "live", true)).toBeNull();
    expect(rangeNote(null, "visible", true)).toBeNull();
    expect(rangeNote(read(), "visible", false)).toBeNull();
    expect(rangeNote(read(), "live")).toBeNull();
    expect(rangeNote(read({ coveredMs: 1 }), "selected")).toBeNull();
  });

  it("says which part of the range has no data once a tenth of its candles' time has none: one stretch by its times, several by their length and count, with the share of the range; nothing under a tenth or while loading", () => {
    expect(MISSING_SAID_FROM).toBe(0.1);
    const note = (missing: [number, number][], tradedMs = 30 * MINUTE, patch: Partial<LiveRangeRead> = {}) => rangeNote(read({ tradedMs, missing, ...patch }), "selected");
    expect(note([[T + 5 * MINUTE, T + 30 * MINUTE]])).toBe("No data for 02:40–03:05 UTC · 83 % of the range");
    expect(note([[T, T + 3 * MINUTE]])).toBe("No data for 02:35–02:38 UTC · 10 % of the range");
    expect(note([[T, T + 2.9 * MINUTE]])).toBeNull();
    expect(note([[T, T + 2 * MINUTE], [T + 10 * MINUTE, T + 12 * MINUTE]])).toBe("No data for 4 min in 2 stretches · 13 % of the range");
    expect(note([[Date.UTC(2026, 9, 16, 23, 0), Date.UTC(2026, 9, 17, 1, 30)]], 10 * 60 * MINUTE)).toBe("No data for 16 Oct 23:00–17 Oct 01:30 UTC · 25 % of the range");
    expect(note([[T, T + 30 * MINUTE]], 30 * MINUTE, { buys: 0, sells: 0, coveredMs: 0 })).toBe("No data for 02:35–03:05 UTC · 100 % of the range");
    expect(note([], 0)).toBeNull();
    expect(note([[T, T + 30 * MINUTE]], 0)).toBeNull();
    expect(rangeNote(read({ tradedMs: 30 * MINUTE, missing: [[T, T + 30 * MINUTE]] }), "selected", true)).toBeNull();
  });

  it("notes what is missing: no candle on screen yet or no trades yet", () => {
    expect(WAITING_TEXT).toBe("waiting for the candles on screen");
    expect(NO_TRADES_TEXT).toEqual({ screen: "no trades on screen yet", zone: "no trades in the zone yet" });
    expect(rangeNote(null)).toBe("waiting for the candles on screen");
    expect(rangeNote(null, "visible")).toBe("waiting for the candles on screen");
    expect(rangeNote(null, "selected")).toBe("waiting for the candles on screen");
    expect(rangeNote(null, "live")).toBe("waiting for the candles on screen");
    expect(rangeNote(read({ coveredMs: 0 }))).toBe("no trades on screen yet");
    expect(rangeNote(read({ coveredMs: 0 }), "selected")).toBe("no trades in the zone yet");
    expect(rangeNote(read({ coveredMs: 0 }), "live")).toBe("no trades in the zone yet");
    expect(rangeNote(read())).toBeNull();
  });
});
