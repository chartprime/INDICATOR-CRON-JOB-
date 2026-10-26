import { describe, expect, it, vi } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import type { BoxData } from "../../../chart/draw/box";
import { withDrawOwnerScope } from "../../../chart/draw/creationScope";
import type { LineData } from "../../../chart/draw/line";
import { handlesForOwners, resetDrawRegistryForTests } from "../../../chart/draw/registry";
import type { IndicatorBarCtx } from "../../../chart/indicatorTypes";
import type { IndicatorLiquidity } from "../../../chart/indicatorLiquidity";
import type { IndicatorBandHistory } from "../../../chart/bandHistory";
import { levelKey, levelsOf } from "../sessionLevelsRules";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import { replayBars } from "../../../chart/replayBars";
import { withStreamCreationWindow } from "../../../chart/ta/creationGuard";
import { shadeOf } from "../sessionLevelsRules";
import { KILLZONE_MAX_INTERVAL_MS } from "../../killzones/killzonesIndicator";
import { MAX_KEPT_BARS, sessionLevelsIndicator, type SessionLevelsState } from "../sessionLevelsIndicator";
import { DEFAULT_SESSION_LEVELS_SETTINGS, LEVEL_LINE_WIDTH, MAX_LEVELS, type SessionLevelsSettings } from "../sessionLevelsRules";
import { MAX_RANGES } from "../sessionRanges";
import type { SessionLevelHover } from "../sessionLevelsHover";

const MINUTE = 60_000;

function ny(day: number, hh: number, mm: number): number {
  return Date.UTC(2026, 0, day, hh + 5, mm);
}

function bar(ts_open: number, high: number, low: number, closed = true): BarFrame {
  return {
    type: "bar", symbol: "/NQZ26:XCME", provider: "DXFEED", assetClass: "FUTURE", interval_ms: MINUTE, ts_open,
    open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 0, trade_count: 1, closed,
  } as BarFrame;
}

function minutes(from: number, to: number): BarFrame[] {
  const bars: BarFrame[] = [];
  for (let ts = from, i = 0; ts <= to; ts += MINUTE, i += 1) bars.push(bar(ts, 100 + (i % 7), 100 - (i % 5)));
  return bars;
}

function context(state: SessionLevelsState, b: BarFrame, settings: SessionLevelsSettings, liquidity?: IndicatorLiquidity): IndicatorBarCtx<SessionLevelsState, SessionLevelsSettings> {
  return {
    bar: b, trades: [], tradeAvailability: "LIVE_COMPLETE", liquidity, state, settings, replace: false, replaying: false,
    ta: {}, draw: { fill: vi.fn() }, markers: { plotshape: vi.fn(), plotchar: vi.fn() }, pane: { paneIndex: 0 },
  };
}

function createState(owner: string, settings = DEFAULT_SESSION_LEVELS_SETTINGS): SessionLevelsState {
  resetDrawRegistryForTests();
  return withDrawOwnerScope(owner, () => withStreamCreationWindow(() => sessionLevelsIndicator.createState(settings)));
}

function feed(state: SessionLevelsState, bars: readonly BarFrame[], settings = DEFAULT_SESSION_LEVELS_SETTINGS, liquidity?: IndicatorLiquidity): void {
  for (const b of bars) sessionLevelsIndicator.onBar(context(state, b, settings, liquidity));
}

/** Ten-second columns, rows 80..130 at a row of one, over seven minutes from `from`: an ask wall of 40 on row 107 and, when asked, buys into it twenty seconds in. Long enough for a window opened in the first minute to close. */
function bookAt(from: number, bigBuys: number, wall = 40): IndicatorLiquidity {
  const columns: LiquidityColumn[] = [];
  for (let i = 0; i < 42; i += 1) {
    const ask = new Float64Array(51);
    ask[107 - 80] = wall;
    const ts = from + i * 10_000;
    const bought = i === 2 && bigBuys > 0;
    columns.push({ ts, lo: 80, hi: 130, ask, bid: new Float64Array(51), prints: bought ? [{ ts: ts - 5_000, price: 107, size: bigBuys, side: "buy", id: null }] : [], buy: bought ? [[107, bigBuys]] : [], sell: [] });
  }
  const feed = { epoch: 1, deep: null, fine: { columns, columnMs: 10_000 } };
  return { get feed() { return feed; }, rowWidth: 1, baseAsset: "NQ", version: 1 };
}

function completeLondonBook(bigBuys: number): IndicatorLiquidity {
  const from = ny(15, 2, 0);
  const fine = bookAt(ny(15, 5, 0), 0);
  const deep: LiquidityColumn[] = [];
  for (let i = 0; i < 36; i += 1) {
    const ts = from + i * 5 * MINUTE;
    deep.push({ ts, lo: 80, hi: 130, ask: new Float64Array(51), bid: new Float64Array(51), prints: i === 0 && bigBuys > 0 ? [{ ts, price: 107, size: bigBuys, side: "buy", id: null }] : [], buy: i === 0 && bigBuys > 0 ? [[107, bigBuys]] : [], sell: [] });
  }
  return { ...fine, feed: { epoch: 1, deep: { columns: deep, columnMs: 5 * MINUTE }, fine: fine.feed.fine } };
}

function drawnLines(owner: string): LineData[] {
  return handlesForOwners([owner]).filter((record) => record.kind === "line").map((record) => record.data as LineData).filter((line) => line.color !== "transparent");
}

function drawnTexts(owner: string): string[] {
  return handlesForOwners([owner]).filter((record) => record.kind === "box").map((record) => String((record.data as BoxData).text)).filter((text) => text !== "");
}

describe("sessionLevelsIndicator", () => {
  it("is a session overlay with no lines, gated like Killzones to charts of thirty minutes and under", () => {
    expect(sessionLevelsIndicator).toMatchObject({ kind: "runtime", id: "sessionLevels", label: "Session Levels", category: "session", lines: [], placement: { kind: "overlay" } });
    expect(sessionLevelsIndicator.timeframeGate?.(KILLZONE_MAX_INTERVAL_MS)).toBe(true);
    expect(sessionLevelsIndicator.timeframeGate?.(KILLZONE_MAX_INTERVAL_MS + 1)).toBe(false);
  });

  it("ships with the sessions Killzones shows by default, all three opening ranges and the session levels on, every field a recompute", () => {
    expect([...DEFAULT_SESSION_LEVELS_SETTINGS.sessions]).toEqual(["asia", "london", "nyam", "nypm"]);
    expect([...DEFAULT_SESSION_LEVELS_SETTINGS.windows]).toEqual([5, 15, 30]);
    expect(DEFAULT_SESSION_LEVELS_SETTINGS.sessionLevels).toBe(true);
    expect(DEFAULT_SESSION_LEVELS_SETTINGS.showSwept).toBe(true);
    expect(sessionLevelsIndicator.settingsSchema?.map((field) => (field.kind === "staticHint" ? null : field.affects))).toEqual(Array.from({ length: 13 }, () => "recompute"));
  });

  it("shades every range in its colour and hides swept levels when the trader turns them off", () => {
    const quiet: SessionLevelsSettings = { ...DEFAULT_SESSION_LEVELS_SETTINGS, showSwept: false };
    const state = createState("shaded", quiet);
    feed(state, minutes(ny(15, 1, 58), ny(15, 5, 0)), quiet);
    const boxes = handlesForOwners(["shaded"]).filter((record) => record.kind === "box").map((record) => record.data as BoxData).filter((box) => box.backgroundColor !== "transparent");
    expect(boxes.map((box) => [box.time1, box.time2, box.price1, box.price2, box.backgroundColor])).toEqual([[ny(15, 2, 0), ny(15, 5, 0), 106, 96, shadeOf(state.builder.ranges[0])]]);
    expect(drawnTexts("shaded")).toEqual(["London.H", "London.L"]);
    feed(state, [bar(ny(15, 5, 1), 119, 100)], quiet, bookAt(ny(15, 5, 1), 0));
    expect(drawnTexts("shaded")).toEqual(["London.L"]);
    expect(drawnLines("shaded").map((line) => line.price1)).toEqual([96]);
  });

  it("draws the fifteen-minute opening range's two levels the moment its window closes, while NY AM still runs, from the window's last bar", () => {
    const state = createState("orb");
    feed(state, minutes(ny(15, 9, 28), ny(15, 9, 43)));
    expect(drawnTexts("orb")).toEqual(["ORB5.H", "ORB5.L"]);
    feed(state, [bar(ny(15, 9, 44), 100, 100)]);
    expect(drawnTexts("orb")).toEqual(["ORB5.H", "ORB5.L", "ORB15.H", "ORB15.L"]);
    feed(state, [bar(ny(15, 9, 45), 100, 100, false)]);
    // The five- and fifteen-minute ranges share both extremes, 106 and 96, so the fifteen's lines take over at 09:35 in their own colour.
    const [, , high, low] = drawnLines("orb");
    expect(high).toMatchObject({ time1: ny(15, 9, 35), time2: ny(15, 9, 45), price1: 106, style: "solid" });
    expect(low).toMatchObject({ time1: ny(15, 9, 35), time2: ny(15, 9, 45), price1: 96, style: "solid" });
  });

  it("draws London's high and low from 02:00 once the session has closed, stops the high on the bar that touches it and runs the low to the live bar", () => {
    const state = createState("london");
    feed(state, minutes(ny(15, 1, 58), ny(15, 4, 59)));
    expect(drawnTexts("london")).not.toContain("London.H");
    feed(state, [bar(ny(15, 5, 0), 100, 100), bar(ny(15, 5, 1), 107, 100), bar(ny(15, 5, 2), 100, 100)]);
    const high = drawnLines("london").find((line) => line.time1 === ny(15, 2, 0) && line.price1 === 106);
    const low = drawnLines("london").find((line) => line.time1 === ny(15, 2, 0) && line.price1 === 96);
    expect([high?.time2, low?.time2]).toEqual([ny(15, 5, 1), ny(15, 5, 2)]);
  });

  it("judges the five minutes from the touch once the columns reach their end: absorbed with NQ's floor and twice the wall, swept when the wick went past the band without the prints", () => {
    // NQ's band is twelve rows, 106..117: a wick to 119 is past it.
    const sweep = bar(ny(15, 5, 1), 119, 100);
    const readOf = (owner: string, bigBuys: number, wall = 40) => {
      const state = createState(owner);
      feed(state, minutes(ny(15, 1, 58), ny(15, 5, 0)));
      feed(state, [sweep], DEFAULT_SESSION_LEVELS_SETTINGS, bookAt(ny(15, 5, 1), bigBuys, wall));
      const high = drawnLines(owner).find((line) => line.price1 === 106 && line.time1 === ny(15, 2, 0));
      return { text: drawnTexts(owner).find((text) => text.startsWith("London.H")), style: high?.style, width: high?.width, end: high?.time2 };
    };
    expect(readOf("absorbed", 100)).toEqual({ text: "London.H · Absorbed · 100 contracts bought / 0 sold", style: "solid", width: LEVEL_LINE_WIDTH, end: ny(15, 5, 1) });
    expect(readOf("swept", 0)).toEqual({ text: "London.H · Liquidity sweep · 0 contracts bought / 0 sold", style: "solid", width: LEVEL_LINE_WIDTH, end: ny(15, 5, 1) });
    // NQ's thin book needs the prints at twice the wall: 100 into 60 is swept there, where the crypto quarter would call it absorbed.
    expect(readOf("thin", 100, 60).text).toBe("London.H · Liquidity sweep · 100 contracts bought / 0 sold");
  });

  it("stops reading a level once its line has ended: volume on a later bar through it changes nothing", () => {
    const state = createState("ended");
    feed(state, minutes(ny(15, 1, 58), ny(15, 5, 0)));
    feed(state, [bar(ny(15, 5, 1), 119, 100)], DEFAULT_SESSION_LEVELS_SETTINGS, bookAt(ny(15, 5, 1), 0));
    expect(drawnTexts("ended")).toContain("London.H · Liquidity sweep · 0 contracts bought / 0 sold");
    feed(state, [bar(ny(15, 5, 2), 119, 100)], DEFAULT_SESSION_LEVELS_SETTINGS, bookAt(ny(15, 5, 2), 50));
    expect(drawnTexts("ended")).toContain("London.H · Liquidity sweep · 0 contracts bought / 0 sold");
    expect(drawnLines("ended").find((line) => line.price1 === 106 && line.time1 === ny(15, 2, 0))?.time2).toBe(ny(15, 5, 1));
  });

  it("writes the resting size for a level price has not reached since it formed, the book on, and runs its line to the live bar", () => {
    const state = createState("untested");
    feed(state, minutes(ny(15, 1, 58), ny(15, 5, 0)));
    feed(state, [bar(ny(15, 5, 1), 101, 99)], DEFAULT_SESSION_LEVELS_SETTINGS, bookAt(ny(15, 5, 1), 0));
    const high = drawnLines("untested").find((line) => line.price1 === 106 && line.time1 === ny(15, 2, 0));
    expect(high).toMatchObject({ time2: ny(15, 5, 1), style: "solid" });
    expect(drawnTexts("untested")).toContain("London.H · resting 40.0 contracts");
  });

  it("does not read the bar that closes a range as a touch of its own level", () => {
    // The five-minute window's last bar, 09:34, reaches its low of 96 again: read as a touch, the low would come out tested.
    const state = createState("own-bar");
    feed(state, minutes(ny(15, 9, 28), ny(15, 9, 33)));
    feed(state, [bar(ny(15, 9, 34), 104, 96), bar(ny(15, 9, 35), 101, 99)], DEFAULT_SESSION_LEVELS_SETTINGS, bookAt(ny(15, 9, 34), 0));
    expect(drawnTexts("own-bar")).toEqual(["ORB5.H · resting 40.0 contracts", "ORB5.L"]);
  });

  it("draws nothing for a session that is off, and only the opening ranges when the session levels are off", () => {
    const off: SessionLevelsSettings = { ...DEFAULT_SESSION_LEVELS_SETTINGS, sessions: new Set(["asia"]) };
    const state = createState("off", off);
    feed(state, minutes(ny(15, 1, 58), ny(15, 5, 2)), off);
    expect(drawnLines("off")).toHaveLength(0);
    const orbsOnly: SessionLevelsSettings = { ...DEFAULT_SESSION_LEVELS_SETTINGS, sessionLevels: false, windows: new Set([30]) };
    const orbs = createState("orbs-only", orbsOnly);
    feed(orbs, minutes(ny(15, 9, 28), ny(15, 11, 2)), orbsOnly);
    expect(drawnTexts("orbs-only")).toEqual(["ORB30.H", "ORB30.L"]);
  });

  it("draws a range in the colour the trader set for it: its lines, its chips and its shade", () => {
    const custom: SessionLevelsSettings = { ...DEFAULT_SESSION_LEVELS_SETTINGS, londonColor: "#123456" };
    const state = createState("coloured", custom);
    feed(state, minutes(ny(15, 1, 58), ny(15, 5, 2)), custom);
    expect(drawnLines("coloured").map((line) => line.color)).toEqual(["#123456", "#123456"]);
    const boxes = handlesForOwners(["coloured"]).filter((record) => record.kind === "box").map((record) => record.data as BoxData);
    expect(boxes.filter((box) => box.text !== "").map((box) => box.textAccent)).toEqual(["#123456", "#123456"]);
    expect(boxes.filter((box) => box.backgroundColor !== "transparent").map((box) => box.backgroundColor)).toEqual([shadeOf(state.builder.ranges[0], custom)]);
    expect(shadeOf(state.builder.ranges[0], custom)).not.toBe(shadeOf(state.builder.ranges[0]));
  });

  it("hands the chart a hover card per level: the range's biggest orders, total and CVD from the book over the range, the same for its high and its low, none for a hidden sweep", () => {
    const state = createState("hover");
    const bars = minutes(ny(15, 1, 58), ny(15, 5, 2));
    feed(state, bars.slice(0, -1));
    feed(state, bars.slice(-1), DEFAULT_SESSION_LEVELS_SETTINGS, bookAt(ny(15, 5, 1), 0));
    const late = sessionLevelsIndicator.getHoverData!(state, DEFAULT_SESSION_LEVELS_SETTINGS) as SessionLevelHover[];
    expect(late.map((hover) => [hover.title, hover.price, hover.lines])).toEqual([
      ["London.H · London · 02:00–05:00 ET", 106, ["no book for this range"]],
      ["London.L · London · 02:00–05:00 ET", 96, ["no book for this range"]],
    ]);
    const inRange = createState("hover-book");
    feed(inRange, bars, DEFAULT_SESSION_LEVELS_SETTINGS, completeLondonBook(100));
    const hovers = sessionLevelsIndicator.getHoverData!(inRange, DEFAULT_SESSION_LEVELS_SETTINGS) as SessionLevelHover[];
    expect(hovers.map((hover) => [hover.title, hover.fromMs, hover.toMs])).toEqual([["London.H · London · 02:00–05:00 ET", ny(15, 2, 0), ny(15, 5, 2)], ["London.L · London · 02:00–05:00 ET", ny(15, 2, 0), ny(15, 5, 2)]]);
    expect(hovers[0].lines).toEqual(["Biggest market buy: 100 contracts", "Biggest market sell: 0 contracts", "Total traded: 100 contracts", "CVD: +100 contracts"]);
    expect(hovers[1].lines).toEqual(hovers[0].lines);
    const quiet: SessionLevelsSettings = { ...DEFAULT_SESSION_LEVELS_SETTINGS, showSwept: false };
    const swept = createState("hover-swept", quiet);
    feed(swept, minutes(ny(15, 1, 58), ny(15, 5, 0)), quiet);
    feed(swept, [bar(ny(15, 5, 1), 119, 100), bar(ny(15, 5, 8), 100, 97)], quiet, bookAt(ny(15, 5, 1), 0));
    expect(drawnTexts("hover-swept")).toEqual(["London.L"]);
    expect((sessionLevelsIndicator.getHoverData!(swept, quiet) as SessionLevelHover[]).map((hover) => hover.title)).toEqual(["London.L · London · 02:00–05:00 ET"]);
    const held = createState("hover-held", quiet);
    feed(held, minutes(ny(15, 1, 58), ny(15, 5, 0)), quiet);
    feed(held, [bar(ny(15, 5, 1), 106, 100), bar(ny(15, 5, 8), 100, 97)], quiet, bookAt(ny(15, 5, 1), 0));
    expect(drawnTexts("hover-held")).toEqual(["London.L"]);
    expect((sessionLevelsIndicator.getHoverData!(held, quiet) as SessionLevelHover[]).map((hover) => hover.title)).toEqual(["London.L · London · 02:00–05:00 ET"]);
    const shown = createState("hover-held-shown");
    feed(shown, minutes(ny(15, 1, 58), ny(15, 5, 0)));
    feed(shown, [bar(ny(15, 5, 1), 106, 100), bar(ny(15, 5, 8), 100, 97)], DEFAULT_SESSION_LEVELS_SETTINGS, bookAt(ny(15, 5, 1), 0));
    expect(drawnTexts("hover-held-shown")[0]).toMatch(/^London\.H · Liquidity sweep/);
  });

  it("reads a range's stats again when the book reaches it later, and afresh when the book is replaced by a new snapshot", () => {
    const state = createState("hover-again");
    const bars = minutes(ny(15, 1, 58), ny(15, 5, 2));
    feed(state, bars, DEFAULT_SESSION_LEVELS_SETTINGS, bookAt(ny(15, 5, 1), 0));
    const cards = () => (sessionLevelsIndicator.getHoverData!(state, DEFAULT_SESSION_LEVELS_SETTINGS) as SessionLevelHover[]).map((hover) => hover.lines[0]);
    expect(cards()).toEqual(["no book for this range", "no book for this range"]);
    feed(state, [bar(ny(15, 5, 3), 100, 98)], DEFAULT_SESSION_LEVELS_SETTINGS, completeLondonBook(100));
    expect(cards()).toEqual(["Biggest market buy: 100 contracts", "Biggest market buy: 100 contracts"]);
    const replaced = completeLondonBook(50);
    const feed2 = { ...replaced.feed, epoch: 2 };
    const snapshot: IndicatorLiquidity = { get feed() { return feed2; }, rowWidth: 1, baseAsset: "NQ", version: 2 };
    feed(state, [bar(ny(15, 5, 4), 100, 98)], DEFAULT_SESSION_LEVELS_SETTINGS, snapshot);
    expect(cards()).toEqual(["Biggest market buy: 50.0 contracts", "Biggest market buy: 50.0 contracts"]);
  });

  it("labels a window from the book it has when the candles say the book missed part of the trading, keeps it undecided, and says so on the hover card", () => {
    const state = createState("partial");
    feed(state, minutes(ny(15, 1, 58), ny(15, 5, 0)));
    const heavy = (ts: number, high: number, low: number) => ({ ...bar(ts, high, low), volume: 50 });
    // Candles first, book after, as on the chart: 100 caught of 250.
    const candles = [heavy(ny(15, 5, 1), 119, 100), heavy(ny(15, 5, 2), 105, 100), heavy(ny(15, 5, 3), 105, 100), heavy(ny(15, 5, 4), 105, 100), heavy(ny(15, 5, 5), 105, 100), heavy(ny(15, 5, 8), 105, 100)];
    feed(state, candles.slice(0, -1));
    feed(state, candles.slice(-1), DEFAULT_SESSION_LEVELS_SETTINGS, bookAt(ny(15, 5, 1), 100));
    expect(drawnTexts("partial")).toContain("London.H · Absorbed · 100 contracts bought / 0 sold");
    const high = levelsOf(state.builder.ranges).find((level) => level.side === "high")!;
    expect(state.statuses.get(levelKey(high))!.window).toMatchObject({ partial: true, verdict: null, best: "absorbed" });
    const card = (sessionLevelsIndicator.getHoverData!(state, DEFAULT_SESSION_LEVELS_SETTINGS) as SessionLevelHover[]).find((hover) => hover.title.startsWith("London.H"))!;
    expect(card.lines.at(-1)).toBe("Label from an incomplete book: 40% of the traded volume");
  });

  it("hides a level whose label is a sweep read from the candles alone when sweeps are off, chip and card", () => {
    const quiet: SessionLevelsSettings = { ...DEFAULT_SESSION_LEVELS_SETTINGS, showSwept: false };
    const state = createState("quiet-candles", quiet);
    feed(state, minutes(ny(15, 1, 58), ny(15, 5, 0)), quiet);
    feed(state, [bar(ny(15, 5, 1), 119, 100), bar(ny(15, 5, 2), 100, 100), bar(ny(15, 5, 12), 100, 100)], quiet, bookAt(ny(15, 5, 10), 0));
    expect(drawnTexts("quiet-candles")).toEqual(["London.L"]);
    expect((sessionLevelsIndicator.getHoverData!(state, quiet) as SessionLevelHover[]).map((hover) => hover.title)).toEqual(["London.L · London · 02:00–05:00 ET"]);
  });

  it("keeps the bars it may have to read again once each, the open bar's latest, and no more than its cap", () => {
    const state = createState("kept");
    feed(state, [bar(ny(15, 9, 30), 101, 99, false), bar(ny(15, 9, 30), 103, 98, false)]);
    expect(state.bars.map((kept) => [kept.ts_open, kept.high])).toEqual([[ny(15, 9, 30), 103]]);
    feed(state, minutes(ny(15, 9, 31), ny(15, 9, 30) + (MAX_KEPT_BARS + 4) * MINUTE));
    expect(state.bars).toHaveLength(MAX_KEPT_BARS);
    expect(state.bars[0].ts_open).toBe(ny(15, 9, 30) + 5 * MINUTE);
  });

  it("creates its slots once, a line and a text for the high and the low of every range it can keep, and survives the replay harness", () => {
    expect(MAX_LEVELS).toBe(2 * MAX_RANGES);
    createState("cap");
    expect(handlesForOwners(["cap"]).filter((record) => record.kind === "line")).toHaveLength(MAX_LEVELS);
    expect(handlesForOwners(["cap"]).filter((record) => record.kind === "box")).toHaveLength(MAX_LEVELS + MAX_RANGES);
    expect(() => replayBars(sessionLevelsIndicator, minutes(ny(15, 1, 58), ny(15, 5, 2)), DEFAULT_SESSION_LEVELS_SETTINGS)).not.toThrow();
  });

  it("asks the host for a touched level and a range the page's book does not reach, judges them from the answer once, and keeps asking so a replay finds it again", () => {
    const state = createState("recorded");
    feed(state, minutes(ny(15, 1, 58), ny(15, 5, 0)));
    const flat = (hh: number, mm: number) => bar(ny(15, hh, mm), 100, 100);
    const late = bookAt(ny(15, 5, 10), 0);
    feed(state, [bar(ny(15, 5, 1), 119, 100), flat(5, 2), flat(5, 12), flat(5, 13)], DEFAULT_SESSION_LEVELS_SETTINGS, late);
    expect(drawnTexts("recorded").find((text) => text.startsWith("London.H"))).toBe("London.H · Liquidity sweep");
    const hoverLines = () => (sessionLevelsIndicator.getHoverData!(state, DEFAULT_SESSION_LEVELS_SETTINGS) as SessionLevelHover[]).map((hover) => hover.lines);
    expect(hoverLines()).toEqual([["no book for this range", "Label from the candles alone: no book at this touch"], ["no book for this range"]]);
    const wants = sessionLevelsIndicator.bandHistoryWanted!(state);
    const levelAsk = wants.find((want) => want.reach === "mid")!;
    const rangeAsk = wants.find((want) => want.reach === "flow")!;
    expect(wants).toHaveLength(2);
    expect(levelAsk).toMatchObject({ fromTs: ny(15, 5, 1), toTs: ny(15, 5, 7), priceLo: 94, priceHi: 119 });
    expect(rangeAsk).toMatchObject({ fromTs: ny(15, 2, 0), toTs: ny(15, 5, 0) - 1 });

    const totals: LiquidityColumn[] = [];
    for (let ts = ny(15, 2, 0); ts < ny(15, 5, 0); ts += MINUTE) totals.push({ ts, lo: 96, hi: 96, bid: new Float64Array(1), ask: new Float64Array(1), buy: ts === ny(15, 2, 0) ? [[100, 30]] : [], sell: ts === ny(15, 2, 1) ? [[99, 10]] : [] });
    const answers = new Map([
      [levelAsk.key, { feed: bookAt(ny(15, 5, 1), 100).feed, rowWidth: 1, gaps: [] }],
      [rangeAsk.key, { feed: { epoch: 1, deep: null, fine: { columns: totals, columnMs: MINUTE } }, rowWidth: 1, gaps: [] }],
    ]);
    const bands: IndicatorBandHistory = { version: 2, older: () => false, feedFor: (key) => answers.get(key) ?? null };
    const next = (hh: number, mm: number, history: IndicatorBandHistory | null = bands) => sessionLevelsIndicator.onBar({ ...context(state, flat(hh, mm), DEFAULT_SESSION_LEVELS_SETTINGS, late), bandHistory: history ?? undefined });
    next(5, 14);
    expect(drawnTexts("recorded").find((text) => text.startsWith("London.H"))).toBe("London.H · Absorbed · 100 contracts bought / 0 sold");
    expect(hoverLines()).toEqual([["Total traded: 40.0 contracts", "CVD: +20.0 contracts"], ["Total traded: 40.0 contracts", "CVD: +20.0 contracts"]]);
    expect(sessionLevelsIndicator.bandHistoryWanted!(state)).toEqual(wants);
    const high = levelsOf(state.builder.ranges).find((level) => level.side === "high")!;
    const read = state.statuses.get(levelKey(high))!.recorded;
    expect(read).toMatchObject({ verdict: "absorbed" });
    next(5, 15);
    expect(state.statuses.get(levelKey(high))!.recorded).toBe(read);
    next(5, 16, null);
    expect(drawnTexts("recorded").find((text) => text.startsWith("London.H"))).toBe("London.H · Absorbed · 100 contracts bought / 0 sold");
    expect(sessionLevelsIndicator.bandHistoryWanted!(state)).toEqual(wants);
  });

  it("asks nothing for a level the page's book judged, and drops a range's ask with the range", () => {
    const state = createState("judged");
    feed(state, minutes(ny(15, 1, 58), ny(15, 5, 0)));
    feed(state, [bar(ny(15, 5, 1), 119, 100)], DEFAULT_SESSION_LEVELS_SETTINGS, bookAt(ny(15, 5, 1), 100));
    expect(drawnTexts("judged").find((text) => text.startsWith("London.H"))).toBe("London.H · Absorbed · 100 contracts bought / 0 sold");
    expect(sessionLevelsIndicator.bandHistoryWanted!(state).map((want) => want.reach)).toEqual(["flow"]);
    feed(state, minutes(ny(16, 2, 0), ny(16, 2, 1)), DEFAULT_SESSION_LEVELS_SETTINGS, bookAt(ny(15, 5, 1), 100));
    expect(state.rangeWants.size).toBe(0);
    expect(sessionLevelsIndicator.bandHistoryWanted!(state)).toEqual([]);
  });
});
