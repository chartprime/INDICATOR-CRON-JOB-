import { describe, expect, it, vi } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import type { IndicatorLiquidity } from "../../../chart/indicatorLiquidity";
import type { IndicatorBarCtx } from "../../../chart/indicatorTypes";
import { withStreamCreationWindow } from "../../../chart/ta/creationGuard";
import { withDrawOwnerScope } from "../../../chart/draw/creationScope";
import { handlesForOwners, resetDrawRegistryForTests } from "../../../chart/draw/registry";
import type { BoxData } from "../../../chart/draw/box";
import { replayBars } from "../../../chart/replayBars";
import type { ColumnFeed } from "../../absorption-detector/absorptionColumns";
import { withAlpha } from "../../classic-order-blocks/orderBlockRender";
import { ACCENT_ALPHA, CARD_FILL, CARD_TEXT, STRONG_FILL_ALPHA } from "../../institutional-order-blocks/institutionalRender";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import { institutionalOrderBlocksV2Indicator, MAX_BARS, MAX_WALLS, snapToBar, type InstitutionalV2State } from "../institutionalOrderBlocksV2";
import { STRONG_BORDER_ALPHA, WALL_TEXT_PADDING, WEAK_ACCENT_ALPHA, WEAK_BORDER_ALPHA, WEAK_CARD_FILL, WEAK_FILL_ALPHA } from "../institutionalV2Render";
import { MITIGATED_CARD_FILL } from "../../institutional-order-blocks/institutionalRender";
import type { InstitutionalV2Settings } from "../institutionalV2Rules";
import { instrumentKey } from "../../../chart/drawingStore";

const T0 = 1_700_000_000_000;
const S = 1_000;
const STEP = 60 * S;
const COLUMN_MS = 10 * S;
// The instrument decides what a wall is, so the fixture speaks its numbers: the BTC perp's band of four rows (row 9 is band 2,
// rows 8..11), wall size 50, weak floor 150, strong size 200. Weak shown, since most of these are about what a wall says.
const SETTINGS: InstitutionalV2Settings = { ...institutionalOrderBlocksV2Indicator.defaultSettings, source: "tracker", showWeak: true };
/** A wall over the weak floor and under the strong size, and the sizes that make it a quarter and three quarters absorbed. */
const WALL = 160;
const QUARTER = 40;
const MOST = 120;
/** A wall over the strong size, and the sizes that make it a quarter and three quarters absorbed. */
const BIG = 240;
const BIG_QUARTER = 60;
const BIG_MOST = 180;
/** A close under row 8, the bottom of the band: what closes through a bid wall there. The bars close at 9.5, inside it. */
const UNDER = 7.5;

function makeBar(ts_open: number, closed = true): BarFrame {
  return {
    type: "bar", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", interval_ms: STEP,
    ts_open, open: 9.5, high: 10, low: 9, close: 9.5, volume: 100, trade_count: 10, closed,
  };
}

function context(state: InstitutionalV2State, bar: BarFrame, settings: InstitutionalV2Settings, liquidity?: IndicatorLiquidity): IndicatorBarCtx<InstitutionalV2State, InstitutionalV2Settings> {
  return {
    bar, trades: [], tradeAvailability: "LIVE_COMPLETE", liquidity, state, settings, replace: false, replaying: false,
    ta: {}, draw: { fill: vi.fn() }, markers: { plotshape: vi.fn(), plotchar: vi.fn() }, pane: { paneIndex: 0 },
  };
}

function createState(settings: InstitutionalV2Settings, ownerId: string): InstitutionalV2State {
  resetDrawRegistryForTests();
  return withDrawOwnerScope(ownerId, () => withStreamCreationWindow(() => institutionalOrderBlocksV2Indicator.createState(settings)));
}

/** Closed bars from T0, one a minute, `count` of them. */
function feedBars(state: InstitutionalV2State, settings: InstitutionalV2Settings, count: number, liquidity?: IndicatorLiquidity, from = 0): void {
  for (let i = from; i < from + count; i += 1) institutionalOrderBlocksV2Indicator.onBar(context(state, makeBar(T0 + i * STEP), settings, liquidity));
}

interface Fixture {
  /** The bid row the wall sits on and its size; the wall stands from T0 until `dies`, and holds `shrinksTo` after that. */
  row?: number;
  size?: number;
  dies?: number;
  shrinksTo?: number;
  /** A sell of this much into the wall's row on the column at T0 + 30 s. */
  hit?: number;
  rowWidth?: number;
}

/** Ten-second columns over rows 0..30 from twenty minutes before T0 to thirty after: the wall from T0, buying of 3 on row 10 every column. */
function bookOf({ row = 9, size = WALL, dies = Infinity, shrinksTo = 0, hit = QUARTER, rowWidth = 1 }: Fixture = {}): IndicatorLiquidity {
  const columns: LiquidityColumn[] = [];
  for (let ts = T0 - 20 * STEP; ts <= T0 + 30 * STEP; ts += COLUMN_MS) {
    const bid = new Float64Array(31);
    if (ts >= T0) bid[row] = ts < dies ? size : shrinksTo;
    const column: LiquidityColumn = { ts, lo: 0, hi: 30, bid, ask: new Float64Array(31), buy: [[10, 3]], sell: [] };
    if (ts === T0 + 30 * S) column.sell = [[row, hit]];
    columns.push(column);
  }
  const feed: ColumnFeed = { epoch: 1, deep: null, fine: { columns, columnMs: COLUMN_MS } };
  return { get feed() { return feed; }, rowWidth, baseAsset: "BTC", version: 1 };
}

function drawnBoxes(ownerId: string): BoxData[] {
  return handlesForOwners([ownerId])
    .filter((record) => record.kind === "box")
    .map((record) => record.data as BoxData)
    .filter((box) => box.time1 !== 0);
}

describe("institutionalOrderBlocksV2Indicator", () => {
  it("retains closed bars while liquidity is unavailable, then remaps their closes when the book arrives", () => {
    const state = createState(SETTINGS, "late-book");
    feedBars(state, SETTINGS, 2);
    expect(state.bars.map((bar) => bar.open)).toEqual([T0, T0 + STEP]);
    institutionalOrderBlocksV2Indicator.onBar(context(state, makeBar(T0 + 2 * STEP, false), SETTINGS, bookOf()));
    expect(state.closes).toEqual([{ ts: T0 + STEP, row: 9 }, { ts: T0 + 2 * STEP, row: 9 }]);
  });

  it("is an L2 overlay with no lines, under its own id and label", () => {
    expect(institutionalOrderBlocksV2Indicator).toMatchObject({ kind: "runtime", id: "institutionalOrderBlocksV2", label: "Institutional Order Blocks v2", category: "l2", lines: [], placement: { kind: "overlay" } });
  });

  it("draws a wall that has stood three minutes as an outlined band from its birth to the bar, with its grade, size, freshness and score on a card inside its right end", () => {
    const state = createState(SETTINGS, "live");
    feedBars(state, SETTINGS, 4, bookOf());
    const boxes = drawnBoxes("live");
    expect(boxes).toHaveLength(1);
    // One sell of 40 into a wall of 160: tested, a quarter absorbed. The band is its four rows, 8 to 12. The score: 160 of
    // the strong 200 is 32, the quarter absorbed the full 30, no refill, and 170 s of the half hour 0.94 -- 63.
    expect(boxes[0]).toMatchObject({
      time1: T0,
      price1: 12,
      time2: T0 + 3 * STEP,
      price2: 8,
      borderColor: withAlpha(SETTINGS.bullishColor, WEAK_BORDER_ALPHA),
      backgroundColor: withAlpha(SETTINGS.bullishColor, WEAK_FILL_ALPHA),
      text: "Weak OB · 160 BTC · Tested · 63/100",
      textAlign: "right",
      textAfterBox: false,
      textColor: CARD_TEXT,
      textBackground: WEAK_CARD_FILL,
      textAccent: withAlpha(SETTINGS.bullishColor, WEAK_ACCENT_ALPHA),
      tailFade: true,
      cornerRadius: 6,
      textPadding: WALL_TEXT_PADDING,
      minHeightPx: SETTINGS.bandThicknessPx,
      textFallbacks: ["Weak OB · 160 BTC · Tested", "Weak OB · 160 BTC", "Weak OB"],
    });
  });

  it("makes a wall strong on the strong size alone, fresh, drawn on the shipped defaults from the moment it stands", () => {
    // No sell into it, and 240 over the perp's strong size of 200: strong by size at three minutes, with nothing absorbed.
    const bySize = { ...SETTINGS, showWeak: false };
    const state = createState(bySize, "by-size");
    feedBars(state, bySize, 4, bookOf({ size: BIG, hit: 0 }));
    expect(drawnBoxes("by-size")[0]).toMatchObject({
      text: "Strong OB · 240 BTC · Fresh · 41/100",
      borderColor: withAlpha(SETTINGS.bullishColor, STRONG_BORDER_ALPHA),
      backgroundColor: withAlpha(SETTINGS.bullishColor, STRONG_FILL_ALPHA),
    });
  });

  it("takes each size from the instrument and not from another: a wall over the wall size but under the weak floor is tracked, not drawn", () => {
    // The perp's wall size is 50 and its weak floor 150: a wall of 100 is a wall the tracker follows and not one worth the chart.
    const state = createState(SETTINGS, "floors");
    feedBars(state, SETTINGS, 4, bookOf({ size: 100, hit: 0 }));
    expect(state.tracker.open.get("bid:2")).toMatchObject({ current: 100, peak: 100 });
    expect(drawnBoxes("floors")).toHaveLength(0);
  });

  it("draws nothing while the book is more than the hole tolerance behind the bar, and draws again once it is within it", () => {
    // The columns end thirty minutes after T0. A bar opening forty-one minutes after has no book; one at thirty-five has.
    const state = createState(SETTINGS, "behind");
    const book = bookOf();
    feedBars(state, SETTINGS, 4, book);
    expect(drawnBoxes("behind")).toHaveLength(1);
    institutionalOrderBlocksV2Indicator.onBar(context(state, makeBar(T0 + 41 * STEP, false), SETTINGS, book));
    expect(drawnBoxes("behind")).toHaveLength(0);
    institutionalOrderBlocksV2Indicator.onBar(context(state, makeBar(T0 + 35 * STEP, false), SETTINGS, book));
    expect(drawnBoxes("behind")).toHaveLength(1);
  });

  it("draws nothing for a wall younger than three minutes", () => {
    const state = createState(SETTINGS, "young");
    feedBars(state, SETTINGS, 3, bookOf());
    expect(drawnBoxes("young")).toHaveLength(0);
  });

  it("turns a wall strong on the bar its hold runs out: sixty percent eaten, and still standing ten minutes on", () => {
    const state = createState(SETTINGS, "strong");
    const book = bookOf({ hit: MOST });
    // Crossed on the column at T0 + 40 s. Now is the last column read, ten seconds before the bar closes: the bar opening at
    // T0 + 9 min reads to T0 + 590 s, 550 s past the crossing; the next reads to T0 + 650 s, 610 past.
    feedBars(state, SETTINGS, 10, book);
    // 32 for size, 30 for three quarters absorbed, 590 s of the half hour 3.28: 65; at 650 s, 3.61: 66.
    expect(drawnBoxes("strong")[0].text).toBe("Weak OB · 160 BTC · Tested · 65/100");
    feedBars(state, SETTINGS, 1, book, 10);
    expect(drawnBoxes("strong")[0]).toMatchObject({
      text: "Strong OB · 160 BTC · Tested · 66/100",
      borderColor: withAlpha(SETTINGS.bullishColor, STRONG_BORDER_ALPHA),
      backgroundColor: withAlpha(SETTINGS.bullishColor, STRONG_FILL_ALPHA),
      textBackground: CARD_FILL,
      textAccent: withAlpha(SETTINGS.bullishColor, ACCENT_ALPHA.strong),
    });
  });

  it("draws only strong walls on the shipped defaults, so a fresh chart is only what has been proven", () => {
    const shipped = { ...SETTINGS, showWeak: false };
    const state = createState(shipped, "shipped");
    const book = bookOf({ hit: MOST });
    feedBars(state, shipped, 10, book);
    expect(drawnBoxes("shipped")).toHaveLength(0);
    feedBars(state, shipped, 1, book, 10);
    expect(drawnBoxes("shipped")).toHaveLength(1);
  });

  it("reads the columns of the bar itself, so a wall nothing traded into that is pulled inside the bar is gone on that bar", () => {
    const state = createState(SETTINGS, "gone");
    // Standing from bar 3; the size leaves twenty seconds into bar 5, nothing ever traded into it.
    const book = bookOf({ dies: T0 + 5 * STEP + 20 * S, hit: 0 });
    feedBars(state, SETTINGS, 5, book);
    expect(drawnBoxes("gone")).toHaveLength(1);
    feedBars(state, SETTINGS, 1, book, 5);
    expect(drawnBoxes("gone")).toHaveLength(0);
    const slots = handlesForOwners(["gone"]).filter((record) => record.kind === "box").map((record) => record.data as BoxData);
    expect(slots.every((slot) => slot.text === "" && slot.textBackground === "")).toBe(true);
  });

  it("keeps a wall that was traded into when its size leaves, off the chart under the floor, and ends it on the bar that closes through it", () => {
    const state = createState(SETTINGS, "closed");
    // Hit for 40 at T0 + 30 s, consumed twenty seconds into bar 5; the bars close at 9.5, inside the wall's band.
    const book = bookOf({ dies: T0 + 5 * STEP + 20 * S });
    feedBars(state, SETTINGS, 6, book);
    // Consumed to nothing: still open, and off the chart while nothing rests, though it reached 160 over the floor of 150.
    expect(state.tracker.open.size).toBe(1);
    expect(drawnBoxes("closed")).toHaveLength(0);
    // A bar closing under the band's bottom row ends it; an open bar there does not.
    institutionalOrderBlocksV2Indicator.onBar(context(state, { ...makeBar(T0 + 6 * STEP, false), close: UNDER }, SETTINGS, book));
    expect(state.tracker.open.size).toBe(1);
    institutionalOrderBlocksV2Indicator.onBar(context(state, { ...makeBar(T0 + 6 * STEP), close: UNDER }, SETTINGS, book));
    expect(state.tracker.open.size).toBe(0);
    expect(drawnBoxes("closed")).toHaveLength(0);
    expect([...state.tracker.memory.values()][0]).toMatchObject({ endReason: "closed" });
  });

  it("guards a wall strong and traded into at once: drawn strong at any size, ended only by a bar closing through it", () => {
    // Over the strong size at 240 with a quarter of it sold into: guarded. Eaten down to 160 twenty seconds into bar 5 --
    // under the strong size, over the chart's floor -- and still drawn strong; a bar closing under it ends it.
    const guarded = { ...SETTINGS, showWeak: false };
    const state = createState(guarded, "guarded");
    const book = bookOf({ size: BIG, hit: BIG_QUARTER, dies: T0 + 5 * STEP + 20 * S, shrinksTo: WALL });
    feedBars(state, guarded, 6, book);
    // 32 for size, 60 of the 240 peak the full 30, 350 s of the half hour 1.94: 64.
    expect(drawnBoxes("guarded")[0].text).toBe("Strong OB · 160 BTC · Tested · 64/100");
    institutionalOrderBlocksV2Indicator.onBar(context(state, { ...makeBar(T0 + 6 * STEP), close: UNDER }, guarded, book));
    expect(drawnBoxes("guarded")).toHaveLength(0);
  });

  it("keeps a wall strong by absorption on the shipped chart at any size above nothing, and takes it off at nothing", () => {
    // Crossed on the column at T0 + 30 s on a hit of 120 into 160, eaten to 40 twenty seconds into bar 5: at bar 11 the hold
    // is up and the wall is drawn strong at 40 -- the trader's rule of 2026-09-20, replacing the morning's floor at the wall
    // size of 50. Eaten to nothing instead, it is off the chart, still standing and still strong, until a bar closes through.
    const shipped = { ...SETTINGS, showWeak: false };
    const state = createState(shipped, "eaten");
    feedBars(state, shipped, 11, bookOf({ hit: MOST, dies: T0 + 5 * STEP + 20 * S, shrinksTo: 40 }));
    // 40 of 200 is 8, 120 of the 160 peak the full 30, 650 s 3.61: 42.
    expect(drawnBoxes("eaten")[0].text).toBe("Strong OB · 40.0 BTC · Tested · 42/100");
    const gone = createState(shipped, "gone-to-nothing");
    feedBars(gone, shipped, 11, bookOf({ hit: MOST, dies: T0 + 5 * STEP + 20 * S }));
    expect(gone.tracker.open.get("bid:2")).toMatchObject({ crossedTs: T0 + 30 * S, current: 0, guarded: false });
    expect(drawnBoxes("gone-to-nothing")).toHaveLength(0);
    // The same book at a size that reached the strong 200, eaten to 160: a quarter absorbed, guarded, drawn strong under
    // the strong size where absorption alone would have gone weak.
    const kept = createState(shipped, "kept");
    feedBars(kept, shipped, 11, bookOf({ size: BIG, hit: BIG_MOST, dies: T0 + 5 * STEP + 20 * S, shrinksTo: WALL }));
    expect(drawnBoxes("kept")[0].text).toBe("Strong OB · 160 BTC · Tested · 66/100");
  });

  it("keeps a guarded wall eaten under the floor on the chart while the bars are on it, under the perp's floor and under one typed over its peak alike", () => {
    // The floor reads what a wall holds now, and a bar on a strong wall keeps it whatever it holds (the trader's rules of
    // 2026-09-21). The bars close inside the band, so a guarded wall of 240 eaten to 100 stays drawn at 100 under the
    // perp's 150 and under a typed 300 alike; away from the bars it would need the floor (the render's own tests).
    const shipped = { ...SETTINGS, showWeak: false };
    const book = bookOf({ size: BIG, hit: BIG_QUARTER, dies: T0 + 5 * STEP + 20 * S, shrinksTo: 100 });
    const state = createState(shipped, "floored");
    feedBars(state, shipped, 6, book);
    expect(state.tracker.open.get("bid:2")).toMatchObject({ guarded: true, current: 100, peak: 240 });
    // 100 of 200 is 20, the quarter of 240 the full 30, 350 s 1.94: 52.
    expect(drawnBoxes("floored")[0].text).toBe("Strong OB · 100 BTC · Tested · 52/100");
    const highFloor = { ...shipped, minSizeByInstrument: { [instrumentKey(makeBar(T0))]: 300 } };
    const onIt = createState(highFloor, "floored-high");
    feedBars(onIt, highFloor, 6, book);
    expect(onIt.tracker.open.get("bid:2")).toMatchObject({ guarded: true });
    expect(drawnBoxes("floored-high")[0].text).toBe("Strong OB · 100 BTC · Tested · 52/100");
  });

  it("draws a mitigated wall faded to the bar that closed through it once those are shown, and a refill there as a new wall from that moment", () => {
    const shown = { ...SETTINGS, showMitigated: true };
    const state = createState(shown, "mitigated");
    // The wall stands from T0 with a hit; the bar opening at T0 + 5 min closes under its band.
    const book = bookOf();
    feedBars(state, shown, 5, book);
    institutionalOrderBlocksV2Indicator.onBar(context(state, { ...makeBar(T0 + 5 * STEP), close: UNDER }, shown, book));
    const [spent] = drawnBoxes("mitigated");
    // The band stops ON the bar that closed through it -- a bar sits at its open -- and the score is frozen at the close:
    // 32 for size, the quarter absorbed 30, six minutes of the half hour 2.
    expect(spent).toMatchObject({ time1: T0, time2: T0 + 5 * STEP, tailFade: false, textBackground: MITIGATED_CARD_FILL });
    expect(spent.text).toBe("Weak OB · 160 BTC · Tested · 64/100");
    // The band is still at size in the columns, so a new wall opens at once, from now: young, fresh, and drawn after its three minutes.
    feedBars(state, shown, 3, book, 6);
    expect(drawnBoxes("mitigated")).toHaveLength(1);
    feedBars(state, shown, 1, book, 9);
    const boxes = drawnBoxes("mitigated").sort((a, b) => a.time1 - b.time1);
    expect(boxes).toHaveLength(2);
    // The close ended the wall at the last column read; the next column, the next bar's first, opens the new one.
    expect(boxes[1]).toMatchObject({ time1: T0 + 6 * STEP, tailFade: true });
    // 32 for size and 230 s of the half hour 1.28: 33.
    expect(boxes[1].text).toBe("Weak OB · 160 BTC · Fresh · 33/100");
  });

  it("keeps a wall price closed through gone when the book changes behind the clock and the read starts over", () => {
    // The trader's chart of 2026-09-19: the deep tier lands behind the clock, the tracker starts over, and walls price had
    // closed through came back alive over the price with their whole cumulative life. The closes are replayed with the columns.
    const shown = { ...SETTINGS, showWeak: true };
    const state = createState(shown, "reread");
    const book = bookOf();
    feedBars(state, shown, 5, book);
    expect(drawnBoxes("reread")).toHaveLength(1);
    // The bar opening at T0 + 5 min closes under the wall's band.
    institutionalOrderBlocksV2Indicator.onBar(context(state, { ...makeBar(T0 + 5 * STEP), close: UNDER }, shown, book));
    expect(drawnBoxes("reread")).toHaveLength(0);
    // A new book: everything read again from the start, with every close since the chart loaded.
    const rebuilt = bookOf();
    Object.defineProperty(rebuilt.feed, "epoch", { value: 2 });
    institutionalOrderBlocksV2Indicator.onBar(context(state, { ...makeBar(T0 + 6 * STEP), close: UNDER }, shown, rebuilt));
    const boxes = drawnBoxes("reread");
    // Only the wall born after the close, and it is young, fresh and drawn from that moment -- not the old one from T0.
    expect(boxes.every((box) => box.time1 >= T0 + 6 * STEP)).toBe(true);
    expect(boxes.map((box) => String(box.text).split(" · ")[2])).not.toContain("Tested");
  });

  it("hides a wall the bars have left behind under the floor, keeps it while a bar is on it, and gives the candle after a wick into it the same grace", () => {
    // The trader's rule of 2026-09-21. A guarded wall of 240 eaten to 100, the floor 150. The bars so far sat on its band
    // (8 to 12): drawn at 100. The first bar away above it is still drawn -- the candle before it sat on the wall, so
    // this one decides -- and it closes away: the next bar, away, hides it, still tracked. A bar back on it: drawn. A
    // bar that wicks down to its top and closes away: drawn, and the candle after, away, is still drawn on that wick's
    // account. It closes away too: the one after it is hidden.
    const shipped = { ...SETTINGS, showWeak: false };
    const book = bookOf({ size: BIG, hit: BIG_QUARTER, dies: T0 + 5 * STEP + 20 * S, shrinksTo: 100 });
    const state = createState(shipped, "away");
    feedBars(state, shipped, 6, book);
    expect(drawnBoxes("away")).toHaveLength(1);
    const away = (ts: number, closed = true) => ({ ...makeBar(ts, closed), open: 20.5, high: 21, low: 20, close: 20.5 });
    institutionalOrderBlocksV2Indicator.onBar(context(state, away(T0 + 6 * STEP), shipped, book));
    expect(drawnBoxes("away")).toHaveLength(1);
    institutionalOrderBlocksV2Indicator.onBar(context(state, away(T0 + 7 * STEP, false), shipped, book));
    expect(drawnBoxes("away")).toHaveLength(0);
    expect(state.tracker.open.get("bid:2")).toMatchObject({ current: 100, guarded: true });
    institutionalOrderBlocksV2Indicator.onBar(context(state, makeBar(T0 + 7 * STEP), shipped, book));
    expect(drawnBoxes("away")).toHaveLength(1);
    institutionalOrderBlocksV2Indicator.onBar(context(state, { ...makeBar(T0 + 8 * STEP), open: 20.5, high: 21, low: 11.5, close: 20.5 }, shipped, book));
    expect(drawnBoxes("away")).toHaveLength(1);
    institutionalOrderBlocksV2Indicator.onBar(context(state, away(T0 + 9 * STEP, false), shipped, book));
    expect(drawnBoxes("away")).toHaveLength(1);
    institutionalOrderBlocksV2Indicator.onBar(context(state, away(T0 + 9 * STEP), shipped, book));
    expect(drawnBoxes("away")).toHaveLength(1);
    institutionalOrderBlocksV2Indicator.onBar(context(state, away(T0 + 10 * STEP, false), shipped, book));
    expect(drawnBoxes("away")).toHaveLength(0);
    // The open bar's own wick reaching the band is enough, whatever its close and the candle before it.
    institutionalOrderBlocksV2Indicator.onBar(context(state, { ...makeBar(T0 + 10 * STEP, false), open: 20.5, high: 21, low: 11.5, close: 20.5 }, shipped, book));
    expect(drawnBoxes("away")).toHaveLength(1);
    // Had the candle after the wick closed through the band instead, one close is all it takes: mitigated.
    const through = createState(shipped, "through");
    feedBars(through, shipped, 6, book);
    institutionalOrderBlocksV2Indicator.onBar(context(through, { ...makeBar(T0 + 6 * STEP), open: 20.5, high: 21, low: 11.5, close: 20.5 }, shipped, book));
    institutionalOrderBlocksV2Indicator.onBar(context(through, { ...makeBar(T0 + 7 * STEP), close: UNDER }, shipped, book));
    expect(through.tracker.open.size).toBe(0);
    expect(drawnBoxes("through")).toHaveLength(0);
  });

  it("remaps the closes it has kept when the grid's row width changes, so they still land on the rows they fell on", () => {
    const state = createState(SETTINGS, "remap");
    // At a width of one the wall's band is rows 8 to 11, prices 8 to 12, and the bars close at 9.5: inside it, so it stands.
    feedBars(state, SETTINGS, 5, bookOf());
    expect(drawnBoxes("remap")).toHaveLength(1);
    // At a width of two the same band is prices 16 to 24, and the closes kept become row 4, under it: the level is broken.
    // The new bar closes at 20, inside the wall, so only the closes carried over the width change can end it.
    institutionalOrderBlocksV2Indicator.onBar(context(state, { ...makeBar(T0 + 5 * STEP), close: 20, high: 20 }, SETTINGS, bookOf({ rowWidth: 2 })));
    expect(state.closes[0]).toEqual({ ts: T0 + STEP, row: 4 });
    expect(drawnBoxes("remap")).toHaveLength(0);
  });

  it("keeps one close for each bar when the chart re-emits it, the last one winning", () => {
    const state = createState(SETTINGS, "reemit");
    const book = bookOf();
    institutionalOrderBlocksV2Indicator.onBar(context(state, makeBar(T0), SETTINGS, book));
    institutionalOrderBlocksV2Indicator.onBar(context(state, { ...makeBar(T0), close: 8.5 }, SETTINGS, book));
    expect(state.bars).toEqual([{ open: T0, ts: T0 + STEP, close: 8.5, low: 9, high: 10 }]);
    expect(state.closes).toEqual([{ ts: T0 + STEP, row: 8 }]);
  });

  it("draws the band on its real rows at every timeframe and leaves its thickness to the pixel floor the trader set", () => {
    // Band 2 is rows 8..11, prices 8 to 12 at a row of one, on a minute chart and a four-hour one alike: the client's ask
    // of 2026-09-24 is one thickness at every zoom, which a price pad cannot give and the chart's floor does.
    const book = bookOf();
    const bars = (intervalMs: number, owner: string, settings = SETTINGS) => {
      const state = createState(settings, owner);
      for (let i = 0; i < (intervalMs >= 60 * STEP ? 1 : 4); i += 1) institutionalOrderBlocksV2Indicator.onBar(context(state, { ...makeBar(T0 + i * intervalMs), interval_ms: intervalMs }, settings, book));
      const [box] = drawnBoxes(owner);
      return [box.price2, box.price1, box.minHeightPx];
    };
    expect(bars(STEP, "floor-1m")).toEqual([8, 12, SETTINGS.bandThicknessPx]);
    expect(bars(240 * STEP, "floor-4h")).toEqual([8, 12, SETTINGS.bandThicknessPx]);
    expect(bars(STEP, "floor-thick", { ...SETTINGS, bandThicknessPx: 40 })).toEqual([8, 12, 40]);
  });

  it("puts a band's edges on the bars they fall in, so the chart can place them at any timeframe", () => {
    // Five-minute bars over ten-second columns: the wall is born at T0, inside the bar that opened at T0.
    const state = createState(SETTINGS, "snapped");
    const fiveMin = { ...SETTINGS };
    const book = bookOf();
    for (let i = 0; i < 4; i += 1) institutionalOrderBlocksV2Indicator.onBar(context(state, { ...makeBar(T0 + i * 5 * STEP), interval_ms: 5 * STEP }, fiveMin, book));
    const [box] = drawnBoxes("snapped");
    // Born at T0 and drawn to the live bar, both bar times; the columns between them are not.
    expect([box.time1, box.time2]).toEqual([T0, T0 + 3 * 5 * STEP]);
  });

  it("snaps to the bar a moment falls in, the oldest bar before them all and the live bar inside it", () => {
    const bars = [{ open: 100 }, { open: 200 }, { open: 300 }];
    expect(snapToBar(bars, 250, 400)).toBe(200);
    expect(snapToBar(bars, 300, 400)).toBe(300);
    expect(snapToBar(bars, 50, 400)).toBe(100);
    expect(snapToBar(bars, 400, 400)).toBe(400);
    expect(snapToBar(bars, 999, 400)).toBe(400);
    expect(snapToBar([], 250, 400)).toBe(400);
  });

  it("draws the four walls a side furthest from price by default, the rest tracked but not drawn", () => {
    // Six bid walls, one a band, on bands 0 to 5 -- bottoms 0, 4, 8, 12, 16, 20. The bars close at 29.5, above them all, so
    // none is closed through; the four furthest from that price are bands 0, 1, 2 and 3 -- the trader's standard setting
    // of 2026-09-20 -- and the two nearest are tracked, not drawn.
    const state = createState(SETTINGS, "levels");
    const book = bookOf({ hit: 0 });
    for (const column of book.feed.fine.columns) if (column.bid[9] > 0) for (const row of [1, 5, 13, 17, 21]) column.bid[row] = WALL;
    for (let i = 0; i < 4; i += 1) institutionalOrderBlocksV2Indicator.onBar(context(state, { ...makeBar(T0 + i * STEP), close: 29.5, high: 30, low: 29 }, SETTINGS, book));
    expect(drawnBoxes("levels").map((box) => box.price2).sort((a, b) => a - b)).toEqual([0, 4, 8, 12]);
    expect(state.tracker.open.size).toBe(6);
  });

  it("keeps at most its cap of closes, shedding the oldest", () => {
    const state = createState(SETTINGS, "capped");
    feedBars(state, SETTINGS, MAX_BARS + 5, bookOf());
    expect(state.bars).toHaveLength(MAX_BARS);
    expect(state.closes).toHaveLength(MAX_BARS);
    expect(state.bars[0].ts).toBe(T0 + 6 * STEP);
  });

  it("draws nothing when the chart feeds no book, and clears what it drew when the book goes", () => {
    const state = createState(SETTINGS, "nobook");
    feedBars(state, SETTINGS, 4);
    expect(drawnBoxes("nobook")).toHaveLength(0);
    feedBars(state, SETTINGS, 1, bookOf(), 4);
    expect(drawnBoxes("nobook")).toHaveLength(1);
    feedBars(state, SETTINGS, 1, undefined, 5);
    expect(drawnBoxes("nobook")).toHaveLength(0);
  });

  it("draws nothing while the grid has no row width yet, since a band would have no price", () => {
    const state = createState(SETTINGS, "nowidth");
    feedBars(state, SETTINGS, 4, bookOf({ rowWidth: 0 }));
    expect(drawnBoxes("nowidth")).toHaveLength(0);
  });

  it("takes the width, the size and the weak floor from the instrument when the settings leave them at zero", () => {
    // BTC perp: four rows, fifty to be a wall, a hundred and fifty to be drawn while weak and fresh. Thirteen a row on rows
    // 8..11 is 52: a wall, but under the weak floor; forty a row is 160 and drawn, over the band's prices.
    const defaults = { ...SETTINGS };
    const spread = (perRow: number) => {
      const book = bookOf({ size: perRow, hit: 0 });
      for (const column of book.feed.fine.columns) if (column.bid[9] > 0) for (const row of [8, 10, 11]) column.bid[row] = perRow;
      return book;
    };
    const hidden = createState(defaults, "hidden");
    feedBars(hidden, defaults, 4, spread(13));
    expect(drawnBoxes("hidden")).toHaveLength(0);
    const state = createState(defaults, "defaults");
    feedBars(state, defaults, 4, spread(40));
    expect(drawnBoxes("defaults")[0]).toMatchObject({ price1: 12, price2: 8 });
    expect(drawnBoxes("defaults")[0].text).toBe("Weak OB · 160 BTC · Fresh · 33/100");
  });

  it("starts the read over when the row width changes, since the bands mean different prices", () => {
    const state = createState(SETTINGS, "regrid");
    feedBars(state, SETTINGS, 4, bookOf());
    expect(drawnBoxes("regrid")[0]).toMatchObject({ price1: 12, price2: 8 });
    // The same columns at twice the width, with the wall now on row 4: its band is rows 4 to 7, prices 8 to 16, and the bars
    // close at 9.5, inside it. A read that carried on would keep the band it had.
    feedBars(state, SETTINGS, 1, bookOf({ row: 4, rowWidth: 2 }), 4);
    expect(drawnBoxes("regrid")).toHaveLength(1);
    expect(drawnBoxes("regrid")[0]).toMatchObject({ price1: 16, price2: 8 });
  });

  it("judges now by the columns, not the bar's open: on a slow chart a wall is drawn and aged by the book's clock", () => {
    // One five-minute bar from T0: its columns reach T0 + 290 s, so the wall has stood, though the bar opened at T0.
    const state = createState(SETTINGS, "slow");
    institutionalOrderBlocksV2Indicator.onBar(context(state, { ...makeBar(T0), interval_ms: 5 * STEP }, SETTINGS, bookOf()));
    expect(drawnBoxes("slow")).toHaveLength(1);
    // 290 s of the half hour is 1.61 on top of 32 and 30: 64, where the bar's open would have given 62.
    expect(drawnBoxes("slow")[0]).toMatchObject({ time2: T0, text: "Weak OB · 160 BTC · Tested · 64/100" });
  });

  it("keeps the band's right edge on the live bar, redrawing on an open bar", () => {
    const state = createState(SETTINGS, "edge");
    feedBars(state, SETTINGS, 4, bookOf());
    expect(drawnBoxes("edge")[0].time2).toBe(T0 + 3 * STEP);
    institutionalOrderBlocksV2Indicator.onBar(context(state, makeBar(T0 + 4 * STEP, false), SETTINGS, bookOf()));
    expect(drawnBoxes("edge")[0].time2).toBe(T0 + 4 * STEP);
  });

  it("creates its box slots once, up to its cap, and survives the shared replay harness", () => {
    createState(SETTINGS, "cap");
    expect(handlesForOwners(["cap"]).filter((record) => record.kind === "box")).toHaveLength(MAX_WALLS + 1);
    const bars = Array.from({ length: 6 }, (_, i) => makeBar(T0 + i * STEP));
    expect(() => replayBars(institutionalOrderBlocksV2Indicator, bars, SETTINGS)).not.toThrow();
  });
});
