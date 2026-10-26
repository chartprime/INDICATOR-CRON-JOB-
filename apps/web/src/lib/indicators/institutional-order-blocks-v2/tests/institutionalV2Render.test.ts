import { describe, expect, it } from "vitest";
import { withAlpha } from "../../classic-order-blocks/orderBlockRender";
import { ACCENT_ALPHA, CARD_FILL, CARD_TEXT, STRONG_FILL_ALPHA } from "../../institutional-order-blocks/institutionalRender";
import { DEFAULT_INSTITUTIONAL_V2_SETTINGS, STRONG_HOLD_MS, type Wall } from "../institutionalV2Rules";
import { MITIGATED_FILL_ALPHA } from "../../classic-order-blocks/orderBlockRender";
import { MITIGATED_ACCENT_ALPHA, MITIGATED_CARD_FILL } from "../../institutional-order-blocks/institutionalRender";
import { MITIGATED_BORDER_ALPHA, STRONG_BORDER_ALPHA, WEAK_ACCENT_ALPHA, WEAK_BORDER_ALPHA, WEAK_CARD_FILL, WEAK_FILL_ALPHA, describeWall, renderWalls, shortenWall, wallPrices } from "../institutionalV2Render";

const NOW = 2_000_000;
/** Born 1,900 s ago -- thirty-one minutes -- with 320 of a peak of 520 traded in, 62%, and crossed long enough ago to be strong now. */
const STRONG: Wall = { side: "bid", band: 25, bandRows: 4, startTs: 100_000, resumedTs: 100_000, peak: 520, current: 499, low: 499, eaten: 320, refills: 0, refilled: 0, crossedTs: NOW - STRONG_HOLD_MS, atStrongSize: false, reachedStrongSize: false, guarded: false, endTs: null, endReason: null };
/** Twice refilled, 9,100 brought back, and back on the chart since 400 s ago after an ending. */
const REFILLED: Wall = { ...STRONG, band: 45, resumedTs: NOW - 400_000, refills: 2, refilled: 9100 };
/** Traded into but never crossed. */
const TESTED: Wall = { ...STRONG, band: 30, crossedTs: null };
const FRESH: Wall = { ...TESTED, band: 35, eaten: 0 };
/** Closed through 700 s ago at the wall size exactly, having been strong on absorption since long before: 1,200 s old when it ended. */
const MITIGATED: Wall = { ...STRONG, band: 50, current: 50, crossedTs: 200_000, endTs: NOW - 700_000, endReason: "closed" };
const SHOW_MITIGATED = { ...DEFAULT_INSTITUTIONAL_V2_SETTINGS, showMitigated: true };
const ROW_WIDTH = 0.5;
const SHOW_WEAK = { ...DEFAULT_INSTITUTIONAL_V2_SETTINGS, showWeak: true };
const SHOW_ALL = { ...SHOW_WEAK, showMitigated: true };
/** The BTC perp's strong size, which the fixtures' 499 is over: full marks for size. */
const STRONG_SIZE = 200;

describe("describeWall", () => {
  // The client's ask of 2026-09-20: the grade, the size, fresh or tested, and a score out of 100 -- the absorbed size,
  // the refills and the age come off the card and into the score, so nobody reads the mechanics off the chart.
  it("puts the grade, the wall as it stands, whether it has been traded into and its score on one line, in the book's unit, and nothing else", () => {
    // At the strong size (40), 320 of a 520 peak absorbed (30), no refill, thirty-one minutes old (10).
    expect(describeWall(STRONG, "strong", NOW, "BTC", STRONG_SIZE)).toBe("Strong OB · 499 BTC · Tested · 80/100");
  });

  it("says Fresh for a wall nothing has traded into, and scores it on size and standing alone", () => {
    expect(describeWall(FRESH, "weak", NOW, "BTC", STRONG_SIZE)).toBe("Weak OB · 499 BTC · Fresh · 50/100");
  });

  it("counts the refills in the score, not on the card", () => {
    expect(describeWall(REFILLED, "strong", NOW, "BTC", STRONG_SIZE)).toBe("Strong OB · 499 BTC · Tested · 100/100");
  });

  it("leaves the unit off when the book has none", () => {
    expect(describeWall(STRONG, "strong", NOW, "", STRONG_SIZE)).toBe("Strong OB · 499 · Tested · 80/100");
  });

  it("shows the wall as it is now, not at its largest, and scores the size the same way", () => {
    // 85 of 200 is 17; 320 of 1,240 is past the quarter, 30; thirty-one minutes, 10.
    expect(describeWall({ ...STRONG, peak: 1240, current: 85 }, "strong", NOW, "BTC", STRONG_SIZE)).toBe("Strong OB · 85.0 BTC · Tested · 57/100");
  });

  it("adds nothing for absorption past the quarter of the peak that earns the guard", () => {
    expect(describeWall({ ...STRONG, eaten: 780 }, "strong", NOW, "BTC", STRONG_SIZE)).toBe("Strong OB · 499 BTC · Tested · 80/100");
  });

  it("scores the size against the strong size it is given, so the same wall reads lower on a thicker book", () => {
    // 499 of 5,000 is 4 marks for size where 499 of 200 was 40.
    expect(describeWall(STRONG, "strong", NOW, "ETH", 5000)).toBe("Strong OB · 499 ETH · Tested · 44/100");
  });
});

describe("shortenWall", () => {
  it("drops the score, then fresh or tested, then the wall, never the grade", () => {
    expect(shortenWall(STRONG, "strong", NOW, "BTC", STRONG_SIZE)).toEqual([
      "Strong OB · 499 BTC · Tested",
      "Strong OB · 499 BTC",
      "Strong OB",
    ]);
  });
});

describe("wallPrices", () => {
  it("spans the band's rows, from the first row's start to the row after its last", () => {
    // Band 25 at four rows is rows 100..103; at half a unit a row that is 50 to 52.
    expect(wallPrices(STRONG, ROW_WIDTH)).toEqual({ bottom: 50, top: 52 });
  });

  it("uses the width the wall was judged at, not any other", () => {
    expect(wallPrices({ ...STRONG, band: 50, bandRows: 2 }, ROW_WIDTH)).toEqual({ bottom: 50, top: 51 });
  });

});

describe("renderWalls", () => {
  function slot() {
    const data: Record<string, unknown> = { text: "", left: null, top: null, right: null, bottom: null, border: "", fill: "", card: "", body: "", accent: "", tail: null, short: null, minHeight: null, pinned: null };
    return {
      handle: {
        setLeftTop: (time: number, price: number) => { data.left = time; data.top = price; },
        setRightBottom: (time: number, price: number) => { data.right = time; data.bottom = price; },
        setBorderColor: (color: string) => { data.border = color; },
        setBackgroundColor: (color: string) => { data.fill = color; },
        setBorderWidth: () => {},
        setText: (text: string) => { data.text = text; },
        setTextColor: (color: string) => { data.body = color; },
        setTextBackground: (color: string) => { data.card = color; },
        setTextAccent: (color: string) => { data.accent = color; },
        setTailFade: (on: boolean) => { data.tail = on; },
        setTextFallbacks: (texts: readonly string[]) => { data.short = texts; },
        setMinHeightPx: (px: number) => { data.minHeight = px; },
        setExtendRight: (on: boolean) => { data.pinned = on; },
        setTextOffsetY: () => {},
        delete: () => {},
      },
      data,
    };
  }

  function render(walls: readonly Wall[], settings = DEFAULT_INSTITUTIONAL_V2_SETTINGS, count = 4, weakFloor = 0, barTs = NOW, mitigated: readonly Wall[] = [], snap: (ts: number) => number = (ts) => ts, priceNow = 51, bars: readonly (readonly [number, number])[] = [[priceNow, priceNow]]) {
    const slots = Array.from({ length: count }, slot);
    renderWalls(slots.map((s) => s.handle), walls, mitigated, settings, NOW, barTs, snap, ROW_WIDTH, "BTC", weakFloor, priceNow, STRONG_SIZE, bars);
    return slots.map((s) => s.data);
  }

  /** A chart whose bars are ten seconds wide, to show a wall's edges landing on them. */
  const onBars = (ts: number) => Math.floor(ts / 10_000) * 10_000;

  /** The text written into each slot, in slot order: the kernel paints slot 0 first, so the last one is on top. */
  const painted = (data: Record<string, unknown>[]) => data.map((d) => String(d.text)).filter((t) => t !== "");
  const grades = (data: Record<string, unknown>[]) => painted(data).map((t) => t.split(" ")[0]);

  it("draws a strong wall and hides the weak ones by default, fresh or tested", () => {
    expect(grades(render([TESTED, FRESH, STRONG]))).toEqual(["Strong"]);
  });

  it("draws the weak walls too once switched on, each saying whether it has been traded into", () => {
    // All three the same size, so the furthest from price paints first and the nearest of them reads in front.
    expect(painted(render([TESTED, FRESH, STRONG], SHOW_WEAK))).toEqual([
      "Weak OB · 499 BTC · Fresh · 50/100",
      "Weak OB · 499 BTC · Tested · 80/100",
      "Strong OB · 499 BTC · Tested · 80/100",
    ]);
  });

  it("draws a wall strong on size, fresh or not, as the tracker marks it, and hides one it does not mark", () => {
    expect(painted(render([{ ...FRESH, peak: 5000, current: 5000, atStrongSize: true }]))).toEqual(["Strong OB · 5.0k BTC · Fresh · 50/100"]);
    expect(painted(render([{ ...FRESH, peak: 5000, current: 5000, atStrongSize: false }]))).toEqual([]);
  });

  it("draws the few nearest price on each side, Levels per Side of them, and all of them at zero", () => {
    // Bid bands 10, 12, 14 are prices 20-22, 24-26, 28-30; ask bands 40, 42, 44 are 80-82, 84-86, 88-90. With price at
    // 55 the nearest bids are 14 then 12, the nearest asks 40 then 42 -- and the sizes say the opposite, to be sure
    // which one decides.
    const bids = [300, 200, 100].map((current, i) => ({ ...STRONG, band: 10 + 2 * i, current }));
    const asks = [100, 200, 300].map((current, i) => ({ ...STRONG, side: "ask" as const, band: 40 + 2 * i, current }));
    const two = render([...bids, ...asks], { ...DEFAULT_INSTITUTIONAL_V2_SETTINGS, levelsPerSide: 2, levelsBy: "nearest" }, 8, 0, NOW, [], (ts) => ts, 55);
    // Painted thinnest first: the bid of 100 at 28, the ask of 100 at 80, then the 200s at 24 and 84.
    expect(two.filter((d) => d.text !== "").map((d) => d.bottom)).toEqual([28, 80, 24, 84]);
    const all = render([...bids, ...asks], { ...DEFAULT_INSTITUTIONAL_V2_SETTINGS, levelsPerSide: 0 }, 8, 0, NOW, [], (ts) => ts, 55);
    expect(painted(all)).toHaveLength(6);
  });

  it("measures the distance from the near edge of the band, so a band price is inside is nearest of all", () => {
    // A wide band of 20 to 30 that a price of 29 is inside, against a narrow one of 30 to 32 a whole unit away. By the
    // near edge the wide one is at no distance at all and wins; by its far edge it would be nine away and by its
    // middle four, and the narrow one would win either way.
    const inside = { ...STRONG, band: 2, bandRows: 20, current: 60 };
    const beyond = { ...STRONG, band: 15, bandRows: 4, current: 9999 };
    expect(wallPrices(inside, ROW_WIDTH)).toEqual({ bottom: 20, top: 30 });
    expect(wallPrices(beyond, ROW_WIDTH)).toEqual({ bottom: 30, top: 32 });
    const one = render([beyond, inside], { ...DEFAULT_INSTITUTIONAL_V2_SETTINGS, levelsPerSide: 1, levelsBy: "nearest" }, 4, 0, NOW, [], (ts) => ts, 29);
    expect(painted(one).map((t) => t.split(" · ")[1])).toEqual(["60.0 BTC"]);
  });

  it("counts the levels a side after the floor and the switch, so a hidden weak wall takes no place", () => {
    // One a side: the strong 100 is drawn, since the weak 900 above it is off the chart by default.
    const walls = [{ ...STRONG, band: 10, current: 100 }, { ...TESTED, band: 12, current: 900 }];
    expect(painted(render(walls, { ...DEFAULT_INSTITUTIONAL_V2_SETTINGS, levelsPerSide: 1, levelsBy: "nearest" })).map((t) => t.split(" · ")[1])).toEqual(["100 BTC"]);
    expect(painted(render(walls, { ...SHOW_WEAK, levelsPerSide: 1, levelsBy: "nearest" })).map((t) => t.split(" · ")[1])).toEqual(["900 BTC"]);
  });

  it("keeps a wall a bar is on down to nothing, and one the bars have left behind only while it holds the floor", () => {
    // The trader's rule of 2026-09-21. STRONG is 50 to 52 and holds 499 of a 520 peak; eaten to 100 with the floor at 200:
    // drawn while a bar is on it (inside, or a wick touching its top or bottom), hidden once the bars are away from it,
    // back when a bar returns or the wall refills to the floor. At nothing it is off the chart even under a bar. The
    // candle after one that wicked into the wall counts as on it too: the trader's grace, so that next candle decides.
    const remnant = { ...STRONG, current: 100 };
    const on = (bars: (readonly [number, number])[], walls = [remnant]) => painted(render(walls, DEFAULT_INSTITUTIONAL_V2_SETTINGS, 4, 200, NOW, [], (ts) => ts, 51, bars)).length;
    expect(on([[50.5, 51.5]])).toBe(1);
    expect(on([[52, 55]])).toBe(1);
    expect(on([[45, 50]])).toBe(1);
    expect(on([[52.5, 55]])).toBe(0);
    expect(on([[45, 49.5]])).toBe(0);
    expect(on([[52.5, 55], [51.8, 55]])).toBe(1);
    expect(on([[52.5, 55], [52.5, 56]])).toBe(0);
    expect(on([[52.5, 55]], [{ ...STRONG, current: 200 }])).toBe(1);
    expect(on([[50.5, 51.5]], [{ ...STRONG, current: 0 }])).toBe(0);
    // A mitigated wall is history and is not weighed at all.
    expect(painted(render([], SHOW_MITIGATED, 4, 200, NOW, [{ ...MITIGATED, current: 50 }], (ts) => ts, 51, [[60, 62]]))).toHaveLength(1);
  });

  it("weighs the size floor on what the wall holds now, never on the most it held: away from the bars a wall is drawn while it holds the floor, whatever its peak", () => {
    // The trader's call of 2026-09-21 evening, for every instrument. Bands 31 to 35 are prices 62 to 72, the bars at 51:
    // away. Peak 520 and 100 now, fresh or eaten: hidden under a floor of 200. Peak 150 and 150 now: hidden. Peak 200 and
    // 60 now: hidden. Holding the floor exactly: drawn. From 2026-09-20 to now the floor read the peak, so a wall that
    // reached it stayed however much had gone; now what has gone is gone from the chart too, unless a bar is on it.
    const breathing = { ...FRESH, band: 31, current: 100 };
    const eaten = { ...TESTED, band: 32, current: 100 };
    const small = { ...FRESH, band: 33, peak: 150, current: 150 };
    const atFloor = { ...FRESH, band: 34, peak: 200, current: 60 };
    const holding = { ...FRESH, band: 35, peak: 520, current: 200 };
    const all = { ...SHOW_WEAK, levelsPerSide: 0 };
    expect(painted(render([holding, breathing, eaten, small, atFloor], all, 6, 200)).map((t) => t.split(" · ")[1])).toEqual(["200 BTC"]);
    expect(painted(render([{ ...holding, current: 199 }], all, 6, 200))).toEqual([]);
    // A bar on a strong wall keeps whatever rests, peak or no peak; the weak walls need the floor under a bar too. Under a
    // bar spanning 50 to 72: the strong remnant of 100 at band 36 is drawn, the four weak walls under 200 are not.
    const strongRemnant = { ...STRONG, band: 36, current: 100 };
    expect(painted(render([holding, breathing, eaten, small, atFloor, strongRemnant], all, 6, 200, NOW, [], (ts) => ts, 51, [[50, 74]])).map((t) => t.split(" · ")[1])).toEqual(["200 BTC", "100 BTC"]);
  });

  it("floors the strong walls the same way: a big wall eaten under the floor is drawn while a bar is on it and hidden once the bars leave", () => {
    // One floor over every wall, whatever its grade, on what rests. The ETH perp wall of 5,318 eaten to 100: on the chart
    // while price is on it, off once price has left it and it holds under the floor, back on the first refill to the floor.
    // TESTED is band 30, prices 60 to 62; the bar at 61 is on it, the bar at 51 is not.
    const consumed = { ...TESTED, guarded: true, peak: 5000, current: 100 };
    expect(grades(render([consumed], DEFAULT_INSTITUTIONAL_V2_SETTINGS, 4, 200, NOW, [], (ts) => ts, 61))).toEqual(["Strong"]);
    expect(grades(render([{ ...consumed, current: 1 }], DEFAULT_INSTITUTIONAL_V2_SETTINGS, 4, 200, NOW, [], (ts) => ts, 61))).toEqual(["Strong"]);
    expect(grades(render([consumed], DEFAULT_INSTITUTIONAL_V2_SETTINGS, 4, 200, NOW, [], (ts) => ts, 51))).toEqual([]);
    expect(grades(render([{ ...consumed, current: 200 }], DEFAULT_INSTITUTIONAL_V2_SETTINGS, 4, 200, NOW, [], (ts) => ts, 51))).toEqual(["Strong"]);
    expect(grades(render([{ ...FRESH, peak: 150, current: 150, atStrongSize: true }], DEFAULT_INSTITUTIONAL_V2_SETTINGS, 4, 200))).toEqual([]);
    // STRONG holds 499 of a 520 peak, the bar on it: drawn under any floor. Away from the bars, drawn at a floor of 499, not 500.
    expect(grades(render([STRONG], DEFAULT_INSTITUTIONAL_V2_SETTINGS, 4, 600))).toEqual(["Strong"]);
    expect(grades(render([STRONG], DEFAULT_INSTITUTIONAL_V2_SETTINGS, 4, 499, NOW, [], (ts) => ts, 61))).toEqual(["Strong"]);
    expect(grades(render([STRONG], DEFAULT_INSTITUTIONAL_V2_SETTINGS, 4, 500, NOW, [], (ts) => ts, 61))).toEqual([]);
  });

  it("draws nothing that has nothing resting, whatever its grade or peak, and draws it again on the first size back", () => {
    // The trader's rule of 2026-09-20: a strong tested wall is printed until it is eaten to nothing or a bar closes through
    // it. Guarded or strong on absorption, at 0 it is off the chart; at 1 it is on. Still tracked: a refill brings it back.
    const guarded = { ...TESTED, guarded: true, peak: 5000, current: 0 };
    expect(grades(render([guarded], DEFAULT_INSTITUTIONAL_V2_SETTINGS, 4, 200, NOW, [], (ts) => ts, 61))).toEqual([]);
    expect(grades(render([{ ...guarded, current: 1 }], DEFAULT_INSTITUTIONAL_V2_SETTINGS, 4, 200, NOW, [], (ts) => ts, 61))).toEqual(["Strong"]);
    expect(grades(render([{ ...STRONG, current: 0 }], DEFAULT_INSTITUTIONAL_V2_SETTINGS, 4, 0))).toEqual([]);
    expect(grades(render([{ ...TESTED, current: 0 }], SHOW_WEAK, 4, 0))).toEqual([]);
  });

  it("leaves the mitigated walls to their own switch: the floor is about what is standing", () => {
    // A wall a bar closed through is usually consumed to nothing, so flooring it would empty the switch that shows them.
    expect(grades(render([], SHOW_MITIGATED, 4, 5000, NOW, [MITIGATED]))).toEqual(["Strong"]);
    // Nor does the nothing-resting rule reach them: closed through at nothing, it is drawn at nothing.
    expect(grades(render([], SHOW_MITIGATED, 4, 0, NOW, [{ ...MITIGATED, current: 0 }]))).toEqual(["Strong"]);
  });

  it("ranks the levels a side by distance from price when asked for the furthest, the outer levels of the book", () => {
    // The same three bids at 20-22, 24-26, 28-30 with price at 55: the furthest two are 300 at 20 and 200 at 24, the
    // far side a higher timeframe is heading for rather than the levels price is already among.
    const bids = [300, 200, 100].map((current, i) => ({ ...STRONG, band: 10 + 2 * i, current }));
    const byDistance = { ...DEFAULT_INSTITUTIONAL_V2_SETTINGS, levelsPerSide: 2, levelsBy: "furthest" as const };
    expect(painted(render(bids, byDistance, 8, 0, NOW, [], (ts) => ts, 55)).map((t) => t.split(" · ")[1])).toEqual(["200 BTC", "300 BTC"]);
    // One a side: the outermost, where nearest would take the innermost and largest the biggest.
    const one = { ...byDistance, levelsPerSide: 1 };
    expect(painted(render(bids, one, 8, 0, NOW, [], (ts) => ts, 55)).map((t) => t.split(" · ")[1])).toEqual(["300 BTC"]);
    expect(painted(render(bids, { ...one, levelsBy: "nearest" }, 8, 0, NOW, [], (ts) => ts, 55)).map((t) => t.split(" · ")[1])).toEqual(["100 BTC"]);
  });

  it("keeps the bigger of two walls the same distance away, whichever end of the book is ranked", () => {
    // Two bands whose near edges meet at 12 with price above them: one four rows from 10, one two rows from 11. Same
    // distance, so the size decides and the order is never the array's. Bands of one width never tie like this, which is
    // why only a band of another width can show it.
    const wide = { ...STRONG, band: 5, bandRows: 4, current: 300 };
    const narrow = { ...STRONG, band: 11, bandRows: 2, current: 100 };
    expect([wallPrices(wide, ROW_WIDTH).top, wallPrices(narrow, ROW_WIDTH).top]).toEqual([12, 12]);
    for (const levelsBy of ["furthest", "nearest"] as const) {
      const one = { ...DEFAULT_INSTITUTIONAL_V2_SETTINGS, levelsPerSide: 1, levelsBy };
      expect(painted(render([narrow, wide], one, 4, 0, NOW, [], (ts) => ts, 55)).map((t) => t.split(" · ")[1])).toEqual(["300 BTC"]);
    }
  });

  it("ranks the levels a side by size when asked for the largest, and by nearness otherwise", () => {
    // The same bands as the nearness test: bids at 20-22, 24-26, 28-30 holding 300, 200, 100 with price at 55. Nearest
    // takes the two closest -- 100 at 28 and 200 at 24; largest takes 300 at 20 and 200 at 24. The trader's filter for
    // a higher timeframe, where the levels worth keeping are the big ones, not the ones price happens to sit by.
    const bids = [300, 200, 100].map((current, i) => ({ ...STRONG, band: 10 + 2 * i, current }));
    const bySize = { ...DEFAULT_INSTITUTIONAL_V2_SETTINGS, levelsPerSide: 2, levelsBy: "largest" as const };
    expect(painted(render(bids, bySize, 8, 0, NOW, [], (ts) => ts, 55)).map((t) => t.split(" · ")[1])).toEqual(["200 BTC", "300 BTC"]);
    const byNearness = { ...DEFAULT_INSTITUTIONAL_V2_SETTINGS, levelsPerSide: 2, levelsBy: "nearest" as const };
    expect(painted(render(bids, byNearness, 8, 0, NOW, [], (ts) => ts, 55)).map((t) => t.split(" · ")[1])).toEqual(["100 BTC", "200 BTC"]);
    // At zero levels a side the ranking decides nothing: every wall is drawn either way.
    expect(painted(render(bids, { ...bySize, levelsPerSide: 0 }, 8, 0, NOW, [], (ts) => ts, 55))).toHaveLength(3);
  });

  it("draws the band on its real rows at the thickness the trader set in pixels, live or mitigated, and a hidden slot at none", () => {
    // The client's ask of 2026-09-24: the same thickness at every zoom. The price edges stay the wall's own, 50 to 52;
    // the chart grows the box to the pixel floor about its middle.
    const [drawn, hidden] = render([STRONG]);
    expect([drawn.bottom, drawn.top, drawn.minHeight]).toEqual([50, 52, DEFAULT_INSTITUTIONAL_V2_SETTINGS.bandThicknessPx]);
    expect([hidden.minHeight, hidden.pinned]).toEqual([0, false]);
    const [spent] = render([], { ...SHOW_MITIGATED, bandThicknessPx: 40 }, 4, 0, NOW, [MITIGATED]);
    expect([spent.bottom, spent.top, spent.minHeight]).toEqual([100, 102, 40]);
  });

  it("runs a standing band to the price axis so every card lines up there, clear of the candles, and stops a mitigated one at the bar that closed through it", () => {
    // The client's ask of 2026-09-24: the cards stay by the axis at any zoom, all on one line.
    const [spent, weak, strong] = render([TESTED, STRONG], SHOW_ALL, 4, 0, NOW, [MITIGATED]);
    expect([spent.pinned, weak.pinned, strong.pinned]).toEqual([false, true, true]);
  });

  it("puts both edges of a band on bars, since the chart knows no time between them", () => {
    // Born seven milliseconds into a bar, drawn on a chart whose bar is still open three milliseconds on.
    const [drawn] = render([{ ...STRONG, startTs: 100_007 }], DEFAULT_INSTITUTIONAL_V2_SETTINGS, 4, 0, NOW + 3, [], onBars);
    expect([drawn.left, drawn.right]).toEqual([100_000, NOW]);
  });

  it("puts a mitigated wall's end on a bar too", () => {
    const spent = { ...MITIGATED, startTs: 100_007, endTs: NOW - 700_007 };
    const [drawn] = render([], SHOW_MITIGATED, 4, 0, NOW, [spent], onBars);
    expect([drawn.left, drawn.right]).toEqual([100_000, 1_290_000]);
  });

  it("runs the band from the column the wall was born to now, over its rows' prices", () => {
    const [drawn] = render([STRONG]);
    expect([drawn.left, drawn.top, drawn.right, drawn.bottom]).toEqual([100_000, 52, NOW, 50]);
  });

  it("runs the band of a wall that came back from the level's first birth, as the heatmap draws the level's run", () => {
    const [drawn] = render([REFILLED]);
    expect([drawn.left, drawn.right]).toEqual([100_000, NOW]);
  });

  it("ends the band at the chart's bar while judging the score and the grade at the columns' clock", () => {
    // The bar opened 50 s before the columns' now. Born 1,000 s before now: the columns' clock gives 5.56 of the ten
    // standing marks, 76 in all; the bar's 950 s would give 5.28, 75. The band still stops at the bar.
    const [drawn] = render([{ ...STRONG, startTs: NOW - 1_000_000 }], DEFAULT_INSTITUTIONAL_V2_SETTINGS, 4, 0, NOW - 50_000);
    expect(drawn.right).toBe(NOW - 50_000);
    expect(String(drawn.text).endsWith("76/100")).toBe(true);
  });

  it("grades by how long the wall has stood since its crossing, as of now", () => {
    // Crossed one tick short of the hold: weak on this bar, strong on the next.
    const almost = { ...STRONG, crossedTs: NOW - STRONG_HOLD_MS + 1 };
    expect(grades(render([almost], SHOW_WEAK))).toEqual(["Weak"]);
    expect(grades(render([{ ...almost, crossedTs: NOW - STRONG_HOLD_MS }], SHOW_WEAK))).toEqual(["Strong"]);
  });

  it("colours a bid wall as support and an ask wall as resistance, each outlined in its colour: strong solid with a full edge on the dark chip, weak faint with a half edge on the dimmer one", () => {
    const teal = DEFAULT_INSTITUTIONAL_V2_SETTINGS.bullishColor;
    const rose = DEFAULT_INSTITUTIONAL_V2_SETTINGS.bearishColor;
    const [weakAsk, strongBid] = render([{ ...TESTED, side: "ask" }, STRONG], SHOW_WEAK);
    expect([weakAsk.border, weakAsk.fill, weakAsk.card, weakAsk.accent]).toEqual([withAlpha(rose, WEAK_BORDER_ALPHA), withAlpha(rose, WEAK_FILL_ALPHA), WEAK_CARD_FILL, withAlpha(rose, WEAK_ACCENT_ALPHA)]);
    expect([strongBid.border, strongBid.fill, strongBid.card, strongBid.accent]).toEqual([withAlpha(teal, STRONG_BORDER_ALPHA), withAlpha(teal, STRONG_FILL_ALPHA), CARD_FILL, withAlpha(teal, ACCENT_ALPHA.strong)]);
  });

  it("sets the words on the card that runs on past the band and fades, with its short forms", () => {
    const [drawn] = render([STRONG]);
    expect([drawn.body, drawn.tail]).toEqual([CARD_TEXT, true]);
    expect(drawn.short).toEqual(["Strong OB · 499 BTC · Tested", "Strong OB · 499 BTC", "Strong OB"]);
  });

  it("paints weak walls first and strong last, so the strong read on top, and the newer of equals in front", () => {
    // Bands 10 and 12: a band apart, so they stay two walls.
    const older = { ...STRONG, band: 10 };
    const newer = { ...STRONG, band: 12 };
    const data = render([older, TESTED, newer], SHOW_WEAK);
    expect(grades(data)).toEqual(["Weak", "Strong", "Strong"]);
    expect(data.map((d) => d.top)).toEqual([wallPrices(TESTED, ROW_WIDTH).top, 22, 26, 0]);
  });

  it("hides a mitigated wall by default, and draws it faded to the bar that closed through it, in the grade it held then, once asked for", () => {
    expect(painted(render([STRONG], DEFAULT_INSTITUTIONAL_V2_SETTINGS, 4, 0, NOW, [MITIGATED]))).toHaveLength(1);
    const data = render([STRONG], SHOW_MITIGATED, 4, 0, NOW, [MITIGATED]);
    expect(grades(data)).toEqual(["Strong", "Strong"]);
    const [spent, live] = data;
    const teal = DEFAULT_INSTITUTIONAL_V2_SETTINGS.bullishColor;
    // Score frozen at the close: 50 of 200 is 10, the absorption 30, and 1,200 s of the half hour 6.67 -- 47, where now
    // would give the full 10. The band stops at the close and does not run on.
    expect(spent.text).toBe("Strong OB · 50.0 BTC · Tested · 47/100");
    expect([spent.left, spent.right, spent.tail]).toEqual([100_000, NOW - 700_000, false]);
    expect([spent.border, spent.fill, spent.card, spent.accent]).toEqual([withAlpha(teal, MITIGATED_BORDER_ALPHA), withAlpha(teal, MITIGATED_FILL_ALPHA), MITIGATED_CARD_FILL, withAlpha(teal, MITIGATED_ACCENT_ALPHA)]);
    expect([live.right, live.tail]).toEqual([NOW, true]);
  });

  it("draws a mitigated wall in the grade it held at the close, weak when it had not earned strong by then", () => {
    const neverCrossed = { ...MITIGATED, crossedTs: null };
    expect(grades(render([], SHOW_MITIGATED, 4, 0, NOW, [neverCrossed]))).toEqual(["Weak"]);
    // Crossed 400 s before the close: not the ten minutes, weak at the close though strong now if it had lived.
    const late = { ...MITIGATED, crossedTs: NOW - 700_000 - 400_000 };
    expect(grades(render([], SHOW_MITIGATED, 4, 0, NOW, [late]))).toEqual(["Weak"]);
  });

  it("paints mitigated walls under everything, and gives them up first when there are more walls than slots", () => {
    const data = render([TESTED, STRONG], { ...SHOW_MITIGATED, showWeak: true }, 4, 0, NOW, [MITIGATED]);
    expect(data.map((d) => [d.tail, String(d.text).split(" ")[0]])).toEqual([[false, "Strong"], [true, "Weak"], [true, "Strong"], [null, ""]]);
    const tight = render([TESTED, STRONG], { ...SHOW_MITIGATED, showWeak: true }, 2, 0, NOW, [MITIGATED]);
    expect(tight.map((d) => d.tail)).toEqual([true, true]);
  });

  it("clears the slots no wall was given, so a wall that ended leaves nothing painted", () => {
    const [, , , empty] = render([STRONG]);
    expect([empty.text, empty.fill, empty.card, empty.left, empty.right]).toEqual(["", "transparent", "", 0, 0]);
  });

  it("gives up the thinnest weak walls first when there are more walls than slots, and never a strong one for a weak", () => {
    // Bands 10, 12, 14, 16 -- a band apart, so none fuse -- top out at 22, 26, 30, 34. Three slots for four walls: the weak
    // wall of 100 goes, the rest paint thinnest first, strong last.
    const walls = [{ ...STRONG, band: 10 }, { ...TESTED, band: 12, current: 100 }, { ...TESTED, band: 14, current: 300 }, { ...TESTED, band: 16, current: 200 }];
    expect(render(walls, SHOW_WEAK, 3).map((d) => d.top)).toEqual([34, 30, 22]);
    // Two strong walls over one slot: the thinner goes.
    expect(render([{ ...STRONG, band: 10, current: 300 }, { ...STRONG, band: 12, current: 400 }], DEFAULT_INSTITUTIONAL_V2_SETTINGS, 1).map((d) => d.top)).toEqual([26]);
  });

  it("draws a wall strong by absorption at any size above nothing, and a mitigated one in the grade it held at the close", () => {
    // The morning's floor at the wall size is gone: strong at 50, at 49, at 1. At nothing, not drawn at all (below).
    for (const current of [50, 49, 1]) expect(grades(render([{ ...STRONG, current }]))).toEqual(["Strong"]);
    // Mitigated at 49 having crossed and held: drawn strong, as it was when closed through.
    expect(grades(render([], SHOW_MITIGATED, 4, 0, NOW, [{ ...MITIGATED, current: 49 }]))).toEqual(["Strong"]);
  });

  it("draws a guarded wall strong whatever its size above nothing, and a mitigated one strong when it was guarded at the close", () => {
    expect(grades(render([{ ...TESTED, guarded: true, current: 1, peak: 5000 }], DEFAULT_INSTITUTIONAL_V2_SETTINGS, 4, 0, 5000))).toEqual(["Strong"]);
    expect(grades(render([], SHOW_MITIGATED, 4, 0, NOW, [{ ...MITIGATED, crossedTs: null, guarded: true }]))).toEqual(["Strong"]);
  });

  it("draws walls whose bands touch each as its own band with its own card, never as one", () => {
    // Band 25 is rows 100..103 and band 26 rows 104..107: at half a unit, 50 to 52 and 52 to 54. Fusing them was tried on
    // 2026-09-19 and turned a shelf of ten walls on the ETH perp into one ten-dollar block; the trader had it reverted.
    // The same size, so the band further from a price of 51 paints first; the point is that they are two bands, not one.
    const data = render([STRONG, { ...STRONG, band: 26 }]);
    expect(data.map((d) => [d.bottom, d.top])).toEqual([[52, 54], [50, 52], [0, 0], [0, 0]]);
    expect(painted(data)).toHaveLength(2);
  });
});
