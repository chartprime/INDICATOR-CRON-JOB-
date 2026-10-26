import { describe, expect, it } from "vitest";
import type { BoxData } from "../../../chart/draw/box";
import { withDrawOwnerScope } from "../../../chart/draw/creationScope";
import type { LineData } from "../../../chart/draw/line";
import { handlesForOwners, resetDrawRegistryForTests } from "../../../chart/draw/registry";
import { withStreamCreationWindow } from "../../../chart/ta/creationGuard";
import { withAlpha } from "../../classic-order-blocks/orderBlockRender";
import { KILLZONE_SESSIONS } from "../../killzones/killzones";
import { createLevelStatus, type LevelStatus } from "../levelStatus";
import type { Verdict, WindowFacts } from "../levelWindow";
import { createLevelSlots, createRangeSlots, lineEnd, renderLevels, renderRanges, type LevelSlot } from "../sessionLevelsRender";
import { CHIP_FILL, CHIP_PADDING, CHIP_RADIUS, CHIP_TEXT, DEFAULT_RANGE_COLORS, DEFAULT_SESSION_LEVELS_SETTINGS, LEVEL_FONT_SIZE, LEVEL_LINE_WIDTH, ORB_COLORS, SESSION_LEVELS_SETTINGS_SCHEMA, SHADE_ALPHA, TEXT_LIFT_PX, colorKeyOf, describeLevel, describeSource, labelSpans, levelName, levelsOf, rangeColor, readsAsSweep, shadeOf, sharesPriceWithEarlier, shortenLevel, textOffsetFor } from "../sessionLevelsRules";
import type { OpeningRange, Range, SessionRange } from "../sessionRanges";

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const LONDON = KILLZONE_SESSIONS.find((session) => session.id === "london")!;
const NYAM = KILLZONE_SESSIONS.find((session) => session.id === "nyam")!;

const NOW = T0 + 600 * MINUTE;
const london: SessionRange = { kind: "session", sessionId: "london", startMs: T0, endMs: T0 + 179 * MINUTE, high: 110, low: 90, highTouchMs: T0 + 200 * MINUTE, lowTouchMs: null };
const orb15: OpeningRange = { kind: "orb", sessionId: "nyam", windowMin: 15, startMs: T0 + 450 * MINUTE, endMs: T0 + 464 * MINUTE, high: 105, low: 95, highTouchMs: null, lowTouchMs: null };
const orb5: OpeningRange = { ...orb15, windowMin: 5, endMs: T0 + 454 * MINUTE, low: 96 };
const orb30: OpeningRange = { ...orb15, windowMin: 30, endMs: T0 + 479 * MINUTE, low: 94 };
const nyam: SessionRange = { ...london, sessionId: "nyam", startMs: T0 + 450 * MINUTE, endMs: T0 + 539 * MINUTE, high: 108, low: 92 };

const status = (over: Partial<LevelStatus> = {}): LevelStatus => ({ ...createLevelStatus(), ...over });
const facts = (over: Partial<WindowFacts> = {}): WindowFacts => ({ before: 0, now: 0, into: 0, through: 0, against: 0, delta: 0, wentPast: false, outAtEnd: false, columns: 30, captured: 0, expected: 0, ...over });
const judged = (verdict: Verdict | null, read: Partial<WindowFacts> = {}, over: Partial<LevelStatus> = {}): LevelStatus =>
  status({ window: { from: T0 + 200 * MINUTE, to: T0 + 205 * MINUTE, open: false, noBook: verdict === null, partial: false, verdict, facts: facts(read) }, ...over });
const testing: LevelStatus = status({ window: { from: T0 + 200 * MINUTE, to: T0 + 205 * MINUTE, open: true, noBook: false, partial: false, verdict: null, facts: facts() } });

function slotsOf(owner: string, count: number): LevelSlot[] {
  resetDrawRegistryForTests();
  return withDrawOwnerScope(owner, () => withStreamCreationWindow(() => createLevelSlots(count)));
}

function lines(owner: string): LineData[] {
  return handlesForOwners([owner]).filter((record) => record.kind === "line").map((record) => record.data as LineData);
}

function texts(owner: string): BoxData[] {
  return handlesForOwners([owner]).filter((record) => record.kind === "box").map((record) => record.data as BoxData);
}

function drawnLines(owner: string): LineData[] {
  return lines(owner).filter((line) => line.color !== "transparent");
}

describe("session level names and looks", () => {
  it("names a level the way Killzones does, its opening range added when it is one", () => {
    const [high, low] = levelsOf([london]);
    expect([levelName(high), levelName(low)]).toEqual(["London.H", "London.L"]);
    const [orbHigh, orbLow] = levelsOf([orb15]);
    expect([levelName(orbHigh), levelName(orbLow)]).toEqual(["ORB15.H", "ORB15.L"]);
  });


  it("gives a session range Killzones' colour and each opening window its own by default, nine apart, and shades each at a faint alpha of its colour", () => {
    expect(rangeColor(london)).toBe(LONDON.lineColor);
    expect(rangeColor(orb15)).toBe(ORB_COLORS[15]);
    const colours = [5, 15, 30].map((windowMin) => rangeColor({ ...orb15, windowMin: windowMin as 5 | 15 | 30 }));
    expect(new Set([...colours, ...KILLZONE_SESSIONS.map((session) => session.lineColor)]).size).toBe(9);
    expect(SHADE_ALPHA).toBeLessThanOrEqual(0.05);
    expect(shadeOf(london)).toBe(withAlpha(LONDON.lineColor, SHADE_ALPHA));
    expect(shadeOf(orb15)).toBe(withAlpha(ORB_COLORS[15], SHADE_ALPHA));
  });

  it("lets the trader pick a colour per range: one setting for each session and each opening window, on the look tab, shown while that range is on", () => {
    expect([colorKeyOf(london), colorKeyOf(orb15), colorKeyOf(orb5)]).toEqual(["londonColor", "orb15Color", "orb5Color"]);
    expect(Object.keys(DEFAULT_RANGE_COLORS).sort()).toEqual(["asiaColor", "londonColor", "nyamColor", "nylunchColor", "nypmColor", "orb15Color", "orb30Color", "orb5Color", "rthColor"]);
    expect(DEFAULT_SESSION_LEVELS_SETTINGS).toMatchObject(DEFAULT_RANGE_COLORS);
    const custom = { ...DEFAULT_SESSION_LEVELS_SETTINGS, londonColor: "#123456", orb15Color: "#abcdef" };
    expect([rangeColor(london, custom), rangeColor(orb15, custom), rangeColor(orb5, custom)]).toEqual(["#123456", "#abcdef", ORB_COLORS[5]]);
    expect(shadeOf(london, custom)).toBe(withAlpha("#123456", SHADE_ALPHA));
    const fields = SESSION_LEVELS_SETTINGS_SCHEMA.filter((field) => field.kind === "color");
    expect(fields.map((field) => [field.key, field.tab])).toEqual(Object.keys(DEFAULT_RANGE_COLORS).map((key) => [key, "visibility"]));
    const rth = fields.find((field) => field.key === "rthColor")!;
    const orb30 = fields.find((field) => field.key === "orb30Color")!;
    expect([rth.visibleIf?.(DEFAULT_SESSION_LEVELS_SETTINGS), rth.visibleIf?.({ ...DEFAULT_SESSION_LEVELS_SETTINGS, sessions: new Set(["rth"]) })]).toEqual([false, true]);
    expect([orb30.visibleIf?.(DEFAULT_SESSION_LEVELS_SETTINGS), orb30.visibleIf?.({ ...DEFAULT_SESSION_LEVELS_SETTINGS, windows: new Set([5]) })]).toEqual([true, false]);
  });

  it("puts a high's text above its line and a low's below", () => {
    expect([textOffsetFor("high"), textOffsetFor("low")]).toEqual([-TEXT_LIFT_PX, TEXT_LIFT_PX]);
  });

  it("gives each range's label the time from where the previous range of its session ended to its own end, the first from its start, other sessions' ranges not counted", () => {
    const rth: SessionRange = { ...nyam, sessionId: "rth", endMs: T0 + 839 * MINUTE };
    const spans = labelSpans([orb5, orb15, orb30, nyam, london, rth], MINUTE);
    expect(spans.get(orb5)).toEqual([T0 + 450 * MINUTE, T0 + 455 * MINUTE]);
    expect(spans.get(orb15)).toEqual([T0 + 455 * MINUTE, T0 + 465 * MINUTE]);
    expect(spans.get(orb30)).toEqual([T0 + 465 * MINUTE, T0 + 480 * MINUTE]);
    expect(spans.get(nyam)).toEqual([T0 + 480 * MINUTE, T0 + 540 * MINUTE]);
    expect(spans.get(london)).toEqual([T0, T0 + 180 * MINUTE]);
    expect(spans.get(rth)).toEqual([T0 + 450 * MINUTE, T0 + 840 * MINUTE]);
  });

  it("makes a high and a low level of every range, each with its own touch", () => {
    expect(levelsOf([london]).map((level) => [level.side, level.price, level.touchMs])).toEqual([["high", 110, T0 + 200 * MINUTE], ["low", 90, null]]);
  });

  it("writes the name alone with no book, the resting size while untested, Testing while the window is open, then the verdict and the volume through the level on both sides, with shorter forms down to nothing", () => {
    const [high] = levelsOf([london]);
    expect(describeLevel(high, null, "BTC")).toBe("London.H");
    expect(shortenLevel(high, null, "BTC")).toEqual([""]);
    expect(describeLevel(high, status(), "BTC")).toBe("London.H");
    expect(describeLevel(high, status({ resting: 200, peak: 300 }), "BTC")).toBe("London.H · resting 200 BTC");
    // An empty band after it held size is a reading, not a missing one: a runtime restart empties the far book for a minute.
    expect(describeLevel(high, status({ resting: 0, peak: 232 }), "BTC")).toBe("London.H · resting 0 BTC");
    expect(describeLevel(high, testing, "BTC")).toBe("London.H · Testing");
    expect(describeLevel(high, judged("held", { through: 12 }), "BTC")).toBe("London.H · Liquidity sweep · 12.0 BTC bought / 0 sold");
    // Volume through the level on both sides, the attacking side first; the band feeds the absorption test only.
    expect(describeLevel(high, judged("absorbed", { into: 80, through: 95, against: 30, before: 200 }), "BTC")).toBe("London.H · Absorbed · 95.0 BTC bought / 30.0 sold");
    expect(shortenLevel(high, judged("absorbed", { into: 80, through: 95 }), "BTC")).toEqual(["London.H · Absorbed", "London.H", ""]);
    expect(describeLevel(high, judged("swept"), "BTC")).toBe("London.H · Liquidity sweep · 0 BTC bought / 0 sold");
    expect(describeLevel(high, judged("weakBreak", { into: 30, through: 90, against: 45 }), "BTC")).toBe("London.H · Weak break · 90.0 BTC bought / 45.0 sold");
    expect(describeLevel(high, judged("strongBreak", { through: 1250, against: 380 }), "BTC")).toBe("London.H · Strong break · 1.3k BTC bought / 380 sold");
    const [, low] = levelsOf([london]);
    expect(describeLevel(low, judged("swept", { into: 7, through: 196, against: 200 }), "BTC")).toBe("London.L · Liquidity sweep · 196 BTC sold / 200 bought");
    expect(describeLevel(high, judged(null), "BTC")).toBe("London.H · no book");
    const partial: LevelStatus = status({ window: { from: T0, to: T0 + 5 * MINUTE, open: false, noBook: false, partial: true, verdict: null, facts: facts({ captured: 527, expected: 1237 }) } });
    expect(describeLevel(high, partial, "BTC")).toBe("London.H · no book");
    const best = (over: Partial<NonNullable<LevelStatus["window"]>>): LevelStatus => status({ window: { ...partial.window!, ...over } });
    expect(describeLevel(high, best({ best: "swept", facts: facts({ through: 12, captured: 527, expected: 1237 }) }), "BTC")).toBe("London.H · Liquidity sweep · 12.0 BTC bought / 0 sold");
    expect(describeLevel(high, best({ bookGap: true, best: "absorbed", facts: facts({ through: 95, against: 30 }) }), "BTC")).toBe("London.H · Absorbed · 95.0 BTC bought / 30.0 sold");
    expect(describeLevel(high, best({ partial: false, noBook: true, best: "swept" }), "BTC")).toBe("London.H · Liquidity sweep");
    expect(describeLevel(high, best({ partial: false, noBook: true, best: "held" }), "BTC")).toBe("London.H · Liquidity sweep");
    expect(describeLevel(high, best({ partial: false, noBook: true, best: "weakBreak" }), "BTC")).toBe("London.H · Break");
    expect(describeLevel(high, best({ partial: false, noBook: true, best: "strongBreak" }), "BTC")).toBe("London.H · Break");
    expect(describeSource(best({ best: "swept" }))).toBe("Label from an incomplete book: 43% of the traded volume");
    expect(describeSource(best({ bookGap: true, best: "absorbed" }))).toBe("Label from an incomplete book: a hole inside this window");
    expect(describeSource(best({ partial: false, noBook: true, best: "swept" }))).toBe("Label from the candles alone: no book at this touch");
    expect([describeSource(judged("held")), describeSource(testing), describeSource(status()), describeSource(null), describeSource(judged(null)), describeSource(partial)]).toEqual([null, null, null, null, null, null]);
    expect(shortenLevel(high, partial, "BTC")).toEqual(["London.H", ""]);
    const [orbHigh] = levelsOf([orb15]);
    expect(shortenLevel(orbHigh, judged("swept", { into: 30 }), "BTC")).toEqual(["ORB15.H · Liquidity sweep", "ORB15.H", ""]);
    expect(shortenLevel(orbHigh, status({ resting: 12, peak: 40 }), "BTC")).toEqual(["ORB15.H", ""]);
    expect(shortenLevel(orbHigh, null, "BTC")).toEqual([""]);
    expect([describeLevel(high, judged("held"), "BTC"), describeLevel(high, judged("absorbed"), "BTC")]).toEqual(["London.H · Liquidity sweep · 0 BTC bought / 0 sold", "London.H · Absorbed · 0 BTC bought / 0 sold"]);
  });

  it("ends the line at the first bar whose wick reached the level, whatever the book said, and runs it to the live bar until then", () => {
    const [high, low] = levelsOf([london]);
    expect(lineEnd(high, NOW)).toBe(T0 + 200 * MINUTE);
    expect(lineEnd(low, NOW)).toBe(NOW);
  });
});

describe("renderLevels", () => {
  it("creates one hidden solid line and one hidden text per slot", () => {
    slotsOf("slots", 3);
    expect(lines("slots")).toHaveLength(3);
    expect(texts("slots")).toHaveLength(3);
    expect(lines("slots")[0]).toMatchObject({ color: "transparent", width: LEVEL_LINE_WIDTH, style: "solid" });
    expect(texts("slots")[0]).toMatchObject({ text: "", borderWidth: 0, backgroundColor: "transparent", textAlign: "left", fontSize: LEVEL_FONT_SIZE, textPadding: CHIP_PADDING, cornerRadius: CHIP_RADIUS, textBackground: "", textAccent: "", textOverLines: true });
  });

  it("draws a session level as a solid line from the session's first bar to where it ends, its name in a chip over the session's own bars, above a high and below a low, the chip's stripe and text in the range's colour", () => {
    const slots = slotsOf("session", 4);
    renderLevels(slots, levelsOf([london]), MINUTE, NOW);
    expect(drawnLines("session")).toEqual([
      { time1: T0, price1: 110, time2: T0 + 200 * MINUTE, price2: 110, color: LONDON.lineColor, width: LEVEL_LINE_WIDTH, style: "solid", extend: "none" },
      { time1: T0, price1: 90, time2: NOW, price2: 90, color: LONDON.lineColor, width: LEVEL_LINE_WIDTH, style: "solid", extend: "none" },
    ]);
    expect(texts("session").slice(0, 2)).toMatchObject([
      { time1: T0, price1: 110, time2: T0 + 180 * MINUTE, price2: 110, text: "London.H", textFallbacks: [""], textColor: CHIP_TEXT, textBackground: CHIP_FILL, textAccent: LONDON.lineColor, textOffsetY: -TEXT_LIFT_PX },
      { time1: T0, price1: 90, time2: T0 + 180 * MINUTE, price2: 90, text: "London.L", textFallbacks: [""], textColor: CHIP_TEXT, textBackground: CHIP_FILL, textAccent: LONDON.lineColor, textOffsetY: TEXT_LIFT_PX },
    ]);
    renderLevels(slots, levelsOf([london]), MINUTE, NOW, (level) => (level.side === "high" ? testing : judged("absorbed")), "BTC");
    expect(texts("session").slice(0, 2).map((box) => [box.text, box.textAccent])).toEqual([["London.H · Testing", LONDON.lineColor], ["London.L · Absorbed · 0 BTC sold / 0 bought", LONDON.lineColor]]);
  });

  it("lays the labels of NY AM's ranges one after another in time, each over its own window past the previous one, with the shorter forms to fall back on", () => {
    const slots = slotsOf("sequence", 8);
    const swept = judged("swept", { through: 20 });
    const reached = levelsOf([orb5, orb15, orb30, nyam]).map((level) => (level.side === "high" ? { ...level, touchMs: T0 + 500 * MINUTE } : level));
    renderLevels(slots, reached, MINUTE, NOW, (level) => (level.side === "high" ? swept : null), "BTC");
    expect(texts("sequence").map((box) => [box.time1, box.time2, box.text, box.textFallbacks])).toEqual([
      [T0 + 450 * MINUTE, T0 + 455 * MINUTE, "ORB5.H · Liquidity sweep · 20.0 BTC bought / 0 sold", ["ORB5.H · Liquidity sweep", "ORB5.H", ""]],
      [T0 + 450 * MINUTE, T0 + 455 * MINUTE, "ORB5.L", [""]],
      [T0 + 455 * MINUTE, T0 + 465 * MINUTE, "ORB15.H · Liquidity sweep · 20.0 BTC bought / 0 sold", ["ORB15.H · Liquidity sweep", "ORB15.H", ""]],
      [T0 + 455 * MINUTE, T0 + 465 * MINUTE, "ORB15.L", [""]],
      [T0 + 465 * MINUTE, T0 + 480 * MINUTE, "ORB30.H · Liquidity sweep · 20.0 BTC bought / 0 sold", ["ORB30.H · Liquidity sweep", "ORB30.H", ""]],
      [T0 + 465 * MINUTE, T0 + 480 * MINUTE, "ORB30.L", [""]],
      [T0 + 480 * MINUTE, T0 + 540 * MINUTE, "NY AM.H · Liquidity sweep · 20.0 BTC bought / 0 sold", ["NY AM.H · Liquidity sweep", "NY AM.H", ""]],
      [T0 + 480 * MINUTE, T0 + 540 * MINUTE, "NY AM.L", [""]],
    ]);
    // The three highs share 105, so each line takes over where the previous window ended; the lows run from 09:30.
    // The highs were reached at 500 and end there; the lows never were and run to the live bar.
    expect(drawnLines("sequence").map((line) => [line.time1, line.time2, line.color])).toEqual([
      [T0 + 450 * MINUTE, T0 + 500 * MINUTE, ORB_COLORS[5]], [T0 + 450 * MINUTE, NOW, ORB_COLORS[5]],
      [T0 + 455 * MINUTE, T0 + 500 * MINUTE, ORB_COLORS[15]], [T0 + 450 * MINUTE, NOW, ORB_COLORS[15]],
      [T0 + 465 * MINUTE, T0 + 500 * MINUTE, ORB_COLORS[30]], [T0 + 450 * MINUTE, NOW, ORB_COLORS[30]],
      [T0 + 450 * MINUTE, T0 + 500 * MINUTE, NYAM.lineColor], [T0 + 450 * MINUTE, NOW, NYAM.lineColor],
    ]);
    expect(LEVEL_LINE_WIDTH).toBeGreaterThanOrEqual(2);
  });

  it("hands the shared price on only to a range of the same session and side that ended later", () => {
    const [orb5High, orb5Low] = levelsOf([orb5]);
    const [orb15High] = levelsOf([orb15]);
    const [rthHigh] = levelsOf([{ ...orb15, kind: "session", sessionId: "rth" } as Range]);
    const all = levelsOf([orb5, orb15]);
    expect(sharesPriceWithEarlier(orb15High, all)).toBe(true);
    expect(sharesPriceWithEarlier(orb5High, all)).toBe(false);
    expect(sharesPriceWithEarlier(orb5Low, all)).toBe(false);
    expect(sharesPriceWithEarlier(rthHigh, [...all, rthHigh])).toBe(false);
    expect(sharesPriceWithEarlier({ ...orb15High, side: "low", price: 105 }, all)).toBe(false);
  });

  it("starts an opening-range level where its shading starts, the session's first bar, in the window's own colour", () => {
    const slots = slotsOf("orb", 2);
    renderLevels(slots, levelsOf([orb15]), MINUTE, NOW);
    expect(drawnLines("orb").map((line) => [line.time1, line.time2, line.color])).toEqual([
      [orb15.startMs, NOW, ORB_COLORS[15]],
      [orb15.startMs, NOW, ORB_COLORS[15]],
    ]);
    expect(texts("orb").map((box) => [box.time1, box.text, box.textColor, box.textBackground, box.textAccent])).toEqual([[orb15.startMs, "ORB15.H", CHIP_TEXT, CHIP_FILL, ORB_COLORS[15]], [orb15.startMs, "ORB15.L", CHIP_TEXT, CHIP_FILL, ORB_COLORS[15]]]);
  });

  it("keeps every line solid whatever the book read, and puts the reading in the text", () => {
    const slots = slotsOf("solid", 2);
    renderLevels(slots, levelsOf([london]), MINUTE, NOW, (level) => (level.side === "high" ? judged("swept") : null), "BTC");
    expect(drawnLines("solid").map((line) => [line.style, line.width])).toEqual([["solid", LEVEL_LINE_WIDTH], ["solid", LEVEL_LINE_WIDTH]]);
    expect(texts("solid").map((box) => box.text)).toEqual(["London.H · Liquidity sweep · 0 BTC bought / 0 sold", "London.L"]);
  });

  it("hides a level the window read as held when swept levels are off, since it reads \"Liquidity sweep\" too", () => {
    const slots = slotsOf("held-off", 2);
    const statusOf = (level: { side: string }) => (level.side === "high" ? judged("held") : null);
    renderLevels(slots, levelsOf([london]), MINUTE, NOW, statusOf, "", { ...DEFAULT_SESSION_LEVELS_SETTINGS, showSwept: false });
    expect(lines("held-off").map((line) => line.color)).toEqual(["transparent", LONDON.lineColor]);
    expect(texts("held-off").map((box) => box.text)).toEqual(["", "London.L"]);
    renderLevels(slots, levelsOf([london]), MINUTE, NOW, statusOf, "BTC", DEFAULT_SESSION_LEVELS_SETTINGS);
    expect(texts("held-off").map((box) => box.text)).toEqual(["London.H · Liquidity sweep · 0 BTC bought / 0 sold", "London.L"]);
  });

  it("reads held and swept as a sweep, and nothing else", () => {
    expect((["held", "swept", "absorbed", "weakBreak", "strongBreak"] as const).map((verdict) => readsAsSweep(verdict))).toEqual([true, true, false, false, false]);
    expect(readsAsSweep(undefined)).toBe(false);
  });

  it("hides a level the window read as swept when swept levels are off, and keeps its twin in its own slot", () => {
    const slots = slotsOf("swept-off", 2);
    const statusOf = (level: { side: string }) => (level.side === "high" ? judged("swept") : null);
    renderLevels(slots, levelsOf([london]), MINUTE, NOW, statusOf, "", { ...DEFAULT_SESSION_LEVELS_SETTINGS, showSwept: false });
    expect(lines("swept-off").map((line) => line.color)).toEqual(["transparent", LONDON.lineColor]);
    expect(texts("swept-off").map((box) => [box.text, box.textFallbacks, box.textBackground, box.textAccent])).toEqual([["", [], "", ""], ["London.L", [""], CHIP_FILL, LONDON.lineColor]]);
    renderLevels(slots, levelsOf([london]), MINUTE, NOW, statusOf, "", DEFAULT_SESSION_LEVELS_SETTINGS);
    expect(drawnLines("swept-off")).toHaveLength(2);
  });

  it("draws a range in the trader's colour when one is set: its line, its chip's stripe and its shade alike", () => {
    const slots = slotsOf("custom", 2);
    const custom = { ...DEFAULT_SESSION_LEVELS_SETTINGS, londonColor: "#123456" };
    renderLevels(slots, levelsOf([london]), MINUTE, NOW, () => null, "", custom);
    expect(drawnLines("custom").map((line) => line.color)).toEqual(["#123456", "#123456"]);
    expect(texts("custom").map((box) => box.textAccent)).toEqual(["#123456", "#123456"]);
    resetDrawRegistryForTests();
    const shades = withDrawOwnerScope("custom-shade", () => withStreamCreationWindow(() => createRangeSlots(1)));
    renderRanges(shades, [london], MINUTE, custom);
    expect(texts("custom-shade").map((box) => box.backgroundColor)).toEqual([withAlpha("#123456", SHADE_ALPHA)]);
  });

  it("hides the slots past the levels, and keeps the newest levels when there are more than slots", () => {
    const slots = slotsOf("cap", 4);
    renderLevels(slots, levelsOf([london]), MINUTE, NOW);
    expect(drawnLines("cap")).toHaveLength(2);
    const ranges: Range[] = [london, orb15, { ...orb15, windowMin: 30, high: 108, low: 92 }];
    renderLevels(slots, levelsOf(ranges), MINUTE, NOW);
    expect(drawnLines("cap").map((line) => line.price1)).toEqual([105, 95, 108, 92]);
    renderLevels(slots, [], MINUTE, NOW);
    expect(drawnLines("cap")).toHaveLength(0);
    expect(texts("cap").every((box) => box.text === "" && box.textColor === "transparent" && box.textBackground === "" && box.textAccent === "")).toBe(true);
  });
});

describe("renderRanges", () => {
  it("shades each range faintly in its colour over its own bars, from the session's first bar to the end of its last, and clears the slots past it", () => {
    resetDrawRegistryForTests();
    const slots = withDrawOwnerScope("ranges", () => withStreamCreationWindow(() => createRangeSlots(3)));
    expect(texts("ranges").map((box) => [box.borderWidth, box.backgroundColor])).toEqual([[0, "transparent"], [0, "transparent"], [0, "transparent"]]);
    renderRanges(slots, [london, orb15], MINUTE);
    expect(texts("ranges").map((box) => [box.time1, box.price1, box.time2, box.price2, box.backgroundColor])).toEqual([
      [T0, 110, T0 + 180 * MINUTE, 90, shadeOf(london)],
      [T0 + 450 * MINUTE, 105, T0 + 465 * MINUTE, 95, shadeOf(orb15)],
      [0, 0, 0, 0, "transparent"],
    ]);
    renderRanges(slots, [], MINUTE);
    expect(texts("ranges").every((box) => box.backgroundColor === "transparent")).toBe(true);
  });
});
