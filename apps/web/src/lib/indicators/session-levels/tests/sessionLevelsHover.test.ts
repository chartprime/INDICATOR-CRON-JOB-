import { describe, expect, it } from "vitest";
import { createLevelStatus, type LevelStatus } from "../levelStatus";
import { levelHovers, rangeKey, rangeTitle } from "../sessionLevelsHover";
import { levelsOf } from "../sessionLevelsRules";
import type { OpeningRange, SessionRange } from "../sessionRanges";

const T0 = Date.UTC(2026, 0, 15, 7, 0);
const MINUTE = 60_000;
const NOW = T0 + 600 * MINUTE;
const london: SessionRange = { kind: "session", sessionId: "london", startMs: T0, endMs: T0 + 179 * MINUTE, high: 110, low: 90, highTouchMs: T0 + 200 * MINUTE, lowTouchMs: null };
const orb5: OpeningRange = { kind: "orb", sessionId: "nyam", windowMin: 5, startMs: T0 + 150 * MINUTE, endMs: T0 + 154 * MINUTE, high: 105, low: 95, highTouchMs: null, lowTouchMs: null };
const orb15: OpeningRange = { ...orb5, windowMin: 15, endMs: T0 + 164 * MINUTE, low: 94 };
const stats = { biggestBuy: 12, biggestSell: 40, bought: 300, sold: 200 };

describe("session level hovers", () => {
  it("names a range with its clock span, and keys it by session, window and start", () => {
    expect(rangeTitle(london, MINUTE)).toBe("London · 02:00–05:00 ET");
    expect(rangeTitle(orb5, MINUTE)).toBe("ORB 5 min · 04:30–04:35 ET");
    expect([rangeKey(london), rangeKey(orb5), rangeKey(orb15)]).toEqual([`london:s:${T0}`, `nyam:5:${T0 + 150 * MINUTE}`, `nyam:15:${T0 + 150 * MINUTE}`]);
  });

  it("gives the high and the low of a range the same card: the range's biggest orders, total and CVD, over the line's own span", () => {
    const hovers = levelHovers(levelsOf([london]), MINUTE, NOW, () => stats, "BTC");
    expect(hovers).toEqual([
      { title: "London.H · London · 02:00–05:00 ET", lines: ["Biggest market buy: 12.0 BTC", "Biggest market sell: 40.0 BTC", "Total traded: 500 BTC", "CVD: +100 BTC"], price: 110, fromMs: T0, toMs: T0 + 200 * MINUTE },
      { title: "London.L · London · 02:00–05:00 ET", lines: hovers[0].lines, price: 90, fromMs: T0, toMs: NOW },
    ]);
  });

  it("starts a shared level's card where its line takes over, and says so when a range has no book", () => {
    const hovers = levelHovers(levelsOf([orb5, orb15]), MINUTE, NOW, (range) => (range === orb5 ? stats : null), "BTC");
    expect(hovers.map((hover) => [hover.title, hover.fromMs, hover.lines.length])).toEqual([
      ["ORB5.H · ORB 5 min · 04:30–04:35 ET", T0 + 150 * MINUTE, 4],
      ["ORB5.L · ORB 5 min · 04:30–04:35 ET", T0 + 150 * MINUTE, 4],
      ["ORB15.H · ORB 15 min · 04:30–04:45 ET", T0 + 155 * MINUTE, 1],
      ["ORB15.L · ORB 15 min · 04:30–04:45 ET", T0 + 150 * MINUTE, 1],
    ]);
    expect(hovers[2].lines).toEqual(["no book for this range"]);
  });

  it("adds where the label came from to a level's card when its window was read from less than a full book, and nothing to a complete one", () => {
    const [high, low] = levelsOf([london]);
    const facts = { before: 0, now: 0, into: 0, through: 0, against: 0, delta: 0, wentPast: true, outAtEnd: false, columns: 0, captured: 0, expected: 0 };
    const candles: LevelStatus = { ...createLevelStatus(), window: { from: T0, to: T0 + 5 * MINUTE, open: false, noBook: true, partial: false, verdict: null, best: "swept", facts } };
    const complete: LevelStatus = { ...createLevelStatus(), window: { from: T0, to: T0 + 5 * MINUTE, open: false, noBook: false, partial: false, verdict: "held", best: "held", facts } };
    const hovers = levelHovers([high, low], MINUTE, NOW, () => stats, "BTC", (level) => (level === high ? candles : complete));
    expect(hovers[0].lines).toEqual(["Biggest market buy: 12.0 BTC", "Biggest market sell: 40.0 BTC", "Total traded: 500 BTC", "CVD: +100 BTC", "Label from the candles alone: no book at this touch"]);
    expect(hovers[1].lines).toHaveLength(4);
  });
});
