import { describe, expect, it, vi } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import type { IndicatorLiquidity } from "../../../chart/indicatorLiquidity";
import type { IndicatorBarCtx } from "../../../chart/indicatorTypes";
import { withStreamCreationWindow } from "../../../chart/ta/creationGuard";
import { withDrawOwnerScope } from "../../../chart/draw/creationScope";
import {
  handlesForOwners,
  resetDrawRegistryForTests,
} from "../../../chart/draw/registry";
import type { BoxData } from "../../../chart/draw/box";
import { replayBars } from "../../../chart/replayBars";
import type { ColumnFeed } from "../../absorption-detector/absorptionColumns";
import {
  DEFAULT_MAX_ORDER_BLOCKS,
  ZONE_WIDTH_LENGTH,
} from "../../classic-order-blocks/orderBlockRules";
import {
  MITIGATED_FILL_ALPHA,
  withAlpha,
} from "../../classic-order-blocks/orderBlockRender";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import {
  institutionalOrderBlocksIndicator,
  type InstitutionalState,
} from "../institutionalOrderBlocks";
import { NO_CARD, REJECTED_BORDER_ALPHA, REJECTED_FILL_ALPHA, STRONG_BORDER_ALPHA, STRONG_FILL_ALPHA, UNVERIFIABLE_BORDER_ALPHA, WEAK_BORDER_ALPHA, WEAK_FILL_ALPHA, ZONE_TEXT, ZONE_TEXT_ON_DARK } from "../institutionalRender";
import type { InstitutionalSettings } from "../institutionalRules";

const T0 = 1_700_000_000_000;
const S = 1_000;
const STEP = 60 * S;
// The fixture's wall is one row of 4 and its hit is 2; the sizes are set to those so the instrument's defaults do not decide.
// Every grade drawn, since most of these are about what a zone says rather than which the trader has switched on.
const SETTINGS: InstitutionalSettings = {
  ...institutionalOrderBlocksIndicator.defaultSettings,
  pivotLength: 2,
  wallSize: 4,
  hitSize: 2,
  showWeak: true,
  showRejected: true,
  showUnverifiable: true,
};

function makeBar(
  ts_open: number,
  high: number,
  low: number,
  close: number,
  closed = true,
): BarFrame {
  return {
    type: "bar",
    provider: "BINANCE",
    marketKind: "PERPETUAL",
    symbol: "BTC-USDT",
    interval_ms: STEP,
    ts_open,
    open: (high + low) / 2,
    high,
    low,
    close,
    volume: 100,
    trade_count: 10,
    closed,
  };
}

function context(
  state: InstitutionalState,
  bar: BarFrame,
  settings: InstitutionalSettings,
  liquidity?: IndicatorLiquidity,
): IndicatorBarCtx<InstitutionalState, InstitutionalSettings> {
  return {
    bar,
    trades: [],
    tradeAvailability: "LIVE_COMPLETE",
    liquidity,
    state,
    settings,
    replace: false,
    replaying: false,
    ta: {},
    draw: { fill: vi.fn() },
    markers: { plotshape: vi.fn(), plotchar: vi.fn() },
    pane: { paneIndex: 0 },
  };
}

function createState(
  settings: InstitutionalSettings,
  ownerId: string,
): InstitutionalState {
  resetDrawRegistryForTests();
  return withDrawOwnerScope(ownerId, () =>
    withStreamCreationWindow(() =>
      institutionalOrderBlocksIndicator.createState(settings),
    ),
  );
}

// The classic fixture: a hundred flat bars to warm the zone width up, then a swing high of 20 on bar 2 of the
// stretch, confirmed on bar 4 whose low of 9 is the base, closed above on bar 6.
const WARMUP: { h: number; l: number; c: number }[] = Array.from(
  { length: ZONE_WIDTH_LENGTH },
  () => ({ h: 11, l: 10, c: 10.5 }),
);
const BULL_BREAK = [
  { h: 12, l: 10, c: 11 },
  { h: 13, l: 10, c: 12 },
  { h: 20, l: 12, c: 19 },
  { h: 15, l: 11, c: 13 },
  { h: 14, l: 9, c: 12 },
  { h: 16, l: 10, c: 15 },
  { h: 22, l: 12, c: 21 },
];
const PIVOT = T0 + (WARMUP.length + 2) * STEP;
const BASE = T0 + (WARMUP.length + 4) * STEP;
const BREAK = T0 + (WARMUP.length + 6) * STEP;
const ATTACK_AT = PIVOT + 80 * S;
// The width at the break: 93 flat ranges of 1 and this stretch's 2, 3, 8, 4, 5, 6, 10. The zone is 9 to 10.31: rows 9 and 10.
const WIDTH_AT_BREAK = (93 + 2 + 3 + 8 + 4 + 5 + 6 + 10) / 100;

function feed(
  state: InstitutionalState,
  settings: InstitutionalSettings,
  bars: readonly { h: number; l: number; c: number }[],
  liquidity?: IndicatorLiquidity,
  startIndex = 0,
): void {
  bars.forEach((c, i) => {
    institutionalOrderBlocksIndicator.onBar(
      context(
        state,
        makeBar(T0 + (startIndex + i) * STEP, c.h, c.l, c.c),
        settings,
        liquidity,
      ),
    );
  });
}

/** A wall of 4 on row 9 throughout -- or spread one a row over rows 8..11, the band BTC perp reads at -- one hit of 2, buying from the base on. */
function column(ts: number, buyingFromBase: boolean, wall: boolean, spread = false): LiquidityColumn {
  const bid = new Float64Array(31);
  if (spread) for (const row of [8, 9, 10, 11]) bid[row] = wall ? 1 : 0;
  else bid[9] = wall ? 4 : 0;
  const out: LiquidityColumn = { ts, lo: 0, hi: 30, bid, ask: new Float64Array(31), buy: [], sell: [] };
  if (ts === ATTACK_AT) out.sell = [[9, 2]];
  if (ts >= BASE) out.buy = buyingFromBase ? [[10, 5]] : [];
  if (ts >= BASE && !buyingFromBase) out.sell = [[12, 5]];
  return out;
}

function bookOf({ buyingFromBase = true, wall = true, spread = false } = {}): IndicatorLiquidity {
  const columns: LiquidityColumn[] = [];
  for (let ts = PIVOT - 400 * S; ts <= BREAK + 10 * STEP; ts += 10 * S) columns.push(column(ts, buyingFromBase, wall, spread));
  const feedValue: ColumnFeed = { epoch: 1, deep: null, fine: { columns, columnMs: 10 * S } };
  return { get feed() { return feedValue; }, rowWidth: 1, baseAsset: "BTC", version: 1 };
}

function drawnBoxes(ownerId: string): BoxData[] {
  return handlesForOwners([ownerId])
    .filter((record) => record.kind === "box")
    .map((record) => record.data as BoxData)
    .filter((box) => box.time1 !== 0);
}

describe("institutionalOrderBlocksIndicator", () => {
  it("is an L2 overlay with no lines, driven by the classic geometry settings", () => {
    expect(institutionalOrderBlocksIndicator).toMatchObject({
      kind: "runtime",
      id: "institutionalOrderBlocks",
      label: "Institutional Order Blocks",
      category: "l2",
      lines: [],
      placement: { kind: "overlay" },
    });
  });

  it("draws the classic zone as strong, saying what stood, what hit it, and the delta, when the book backs it", () => {
    const state = createState(SETTINGS, "live");
    feed(state, SETTINGS, [...WARMUP, ...BULL_BREAK], bookOf());
    const boxes = drawnBoxes("live");
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({
      time1: BASE,
      price1: 9 + WIDTH_AT_BREAK,
      time2: BREAK,
      price2: 9,
      borderColor: withAlpha(SETTINGS.bullishColor, STRONG_BORDER_ALPHA),
      backgroundColor: withAlpha(SETTINGS.bullishColor, STRONG_FILL_ALPHA),
      text: "Strong OB · 4.00 BTC · Traded 2.00 BTC · +100% Delta",
      textAlign: "right",
      textAfterBox: false,
      extendRight: true,
      textColor: ZONE_TEXT,
      textBackground: NO_CARD,
      textAccent: "",
      tailFade: true,
      cornerRadius: 6,
      textPadding: 8,
      keepTextClear: false,
      textFallbacks: [
        "Strong OB · 4.00 BTC · Traded 2.00 BTC",
        "Strong OB · 4.00 BTC",
        "Strong OB",
      ],
    });
  });

  it("draws a zone the book did not follow through on as weak, at the weaker style, still saying why", () => {
    const state = createState(SETTINGS, "weak");
    feed(
      state,
      SETTINGS,
      [...WARMUP, ...BULL_BREAK],
      bookOf({ buyingFromBase: false }),
    );
    const [box] = drawnBoxes("weak");
    expect(box).toMatchObject({
      borderColor: withAlpha(SETTINGS.bullishColor, WEAK_BORDER_ALPHA),
      backgroundColor: withAlpha(SETTINGS.bullishColor, WEAK_FILL_ALPHA),
      text: "Weak OB · 4.00 BTC · Traded 2.00 BTC · -100% Delta",
      textBackground: NO_CARD,
      textAccent: "",
    });
  });

  it("reads the wall over the instrument's band by default, so four rows of one make the wall one row of four did", () => {
    const state = createState(SETTINGS, "band");
    feed(state, SETTINGS, [...WARMUP, ...BULL_BREAK], bookOf({ spread: true }));
    expect(drawnBoxes("band")[0].text).toBe("Strong OB · 4.00 BTC · Traded 2.00 BTC · +100% Delta");
    const single = { ...SETTINGS, bandRows: 1 };
    const one = createState(single, "one-row");
    feed(one, single, [...WARMUP, ...BULL_BREAK], bookOf({ spread: true }));
    expect(drawnBoxes("one-row")[0].text).toBe("Rejected OB · no wall stood here · +100% Delta");
  });

  it("makes every zone with the light ink it takes on a dark chart", () => {
    createState(SETTINGS, "inks");
    const boxes = handlesForOwners(["inks"]).filter((record) => record.kind === "box").map((record) => record.data as BoxData);
    expect(ZONE_TEXT_ON_DARK).toMatch(/^#[0-9a-f]{6}$/i);
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.every((box) => box.textColorOnDark === ZONE_TEXT_ON_DARK)).toBe(true);
  });

  it("makes every zone ask to keep its words within its own height, so a thin zone paints no words over the candles", () => {
    createState(SETTINGS, "fits");
    const boxes = handlesForOwners(["fits"]).filter((record) => record.kind === "box").map((record) => record.data as BoxData);
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.every((box) => box.textFitsHeight)).toBe(true);
  });

  it("takes the wall and hit sizes from the instrument when the settings leave them at zero", () => {
    const defaults = { ...SETTINGS, wallSize: 0, hitSize: 0 };
    const state = createState(defaults, "defaults");
    feed(state, defaults, [...WARMUP, ...BULL_BREAK], bookOf());
    expect(drawnBoxes("defaults")[0].text).toBe(
      "Rejected OB · no wall stood here · +100% Delta",
    );
  });

  it("draws a zone the book turned down faint by default, graded and saying so, rather than dropping what the classic block shows", () => {
    const state = createState(SETTINGS, "turned-down");
    feed(state, SETTINGS, [...WARMUP, ...BULL_BREAK], bookOf({ wall: false }));
    const [box] = drawnBoxes("turned-down");
    expect(box).toMatchObject({
      borderColor: withAlpha(SETTINGS.bullishColor, REJECTED_BORDER_ALPHA),
      backgroundColor: withAlpha(SETTINGS.bullishColor, REJECTED_FILL_ALPHA),
      textBackground: NO_CARD,
      textAccent: "",
    });
    expect(box.text).toMatch(/^Rejected/);
  });

  it("draws the zone as an outline that says there is no book when the chart feeds none, rather than dropping it", () => {
    const state = createState(SETTINGS, "nobook");
    feed(state, SETTINGS, [...WARMUP, ...BULL_BREAK]);
    const [box] = drawnBoxes("nobook");
    expect(box).toMatchObject({
      borderColor: withAlpha(SETTINGS.bullishColor, UNVERIFIABLE_BORDER_ALPHA),
      backgroundColor: "transparent",
      text: "Unverified OB · no book",
      textBackground: NO_CARD,
      textAccent: "",
    });
  });

  it("draws nothing but the strong zones on the shipped defaults, so a fresh chart is only what the book backed", () => {
    const shipped = {
      ...SETTINGS,
      showWeak: false,
      showRejected: false,
      showUnverifiable: false,
    };
    const state = createState(shipped, "shipped");
    feed(
      state,
      shipped,
      [...WARMUP, ...BULL_BREAK],
      bookOf({ buyingFromBase: false }),
    );
    expect(drawnBoxes("shipped")).toHaveLength(0);
  });

  it("hides an unverifiable zone when the trader turns those off", () => {
    const hidden = { ...SETTINGS, showUnverifiable: false };
    const state = createState(hidden, "hidden");
    feed(state, hidden, [...WARMUP, ...BULL_BREAK]);
    expect(drawnBoxes("hidden")).toHaveLength(0);
  });

  it("grades a zone that was waiting for the book on the first bar the book is there", () => {
    const state = createState(SETTINGS, "late");
    feed(state, SETTINGS, [...WARMUP, ...BULL_BREAK]);
    expect(drawnBoxes("late")[0].text).toBe("Unverified OB · no book");
    feed(
      state,
      SETTINGS,
      [{ h: 22, l: 20, c: 21 }],
      bookOf(),
      WARMUP.length + BULL_BREAK.length,
    );
    expect(drawnBoxes("late")[0].text).toMatch(/^Strong/);
  });

  it("draws a mitigated block as spent when those are shown, keeping its verdict and ending at the bar that spent it", () => {
    const shown = { ...SETTINGS, showMitigated: true };
    const state = createState(shown, "spent");
    feed(
      state,
      shown,
      [...WARMUP, ...BULL_BREAK, { h: 22, l: 8.5, c: 8.8 }],
      bookOf(),
    );
    const [box] = drawnBoxes("spent");
    expect(box).toMatchObject({
      time2: BREAK + STEP,
      borderColor: "transparent",
      extendRight: false,
      backgroundColor: withAlpha(SETTINGS.bullishColor, MITIGATED_FILL_ALPHA),
      textColor: ZONE_TEXT,
      textBackground: NO_CARD,
      textAccent: "",
      tailFade: false,
    });
    expect(box.text).toMatch(/^Strong/);
  });

  it("clears a slot's text and backing along with its geometry when its block goes hidden", () => {
    const state = createState(SETTINGS, "cleared");
    feed(state, SETTINGS, [...WARMUP, ...BULL_BREAK], bookOf());
    expect(drawnBoxes("cleared")[0].text).toMatch(/^Strong/);
    // The close at 8.8 spends the bullish block and, being a close under the swing low of 9, also breaks it:
    // a bearish block hanging from the 22 high forms on the same bar. The spent one's slot must be clean.
    feed(
      state,
      SETTINGS,
      [{ h: 22, l: 8.5, c: 8.8 }],
      bookOf(),
      WARMUP.length + BULL_BREAK.length,
    );
    const boxes = drawnBoxes("cleared");
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({
      price1: 22,
      borderColor: expect.not.stringContaining(SETTINGS.bullishColor),
    });
    const slots = handlesForOwners(["cleared"])
      .filter((record) => record.kind === "box")
      .map((record) => record.data as BoxData);
    expect(
      slots
        .filter((slot) => slot.time1 === 0)
        .every((slot) => slot.text === "" && slot.textBackground === "" && slot.extendRight === false),
    ).toBe(true);
  });

  it("keeps the zone's right edge on the live bar, redrawing on an open bar without advancing the tracker", () => {
    const state = createState(SETTINGS, "edge");
    feed(state, SETTINGS, [...WARMUP, ...BULL_BREAK], bookOf());
    expect(drawnBoxes("edge")[0].time2).toBe(BREAK);
    institutionalOrderBlocksIndicator.onBar(
      context(
        state,
        makeBar(BREAK + STEP, 22, 20, 21, false),
        SETTINGS,
        bookOf(),
      ),
    );
    const boxes = drawnBoxes("edge");
    expect(boxes).toHaveLength(1);
    expect(boxes[0].time2).toBe(BREAK + STEP);
    expect(boxes[0].text).toMatch(/^Strong/);
    expect(
      state.tracker.classic.bars[state.tracker.classic.bars.length - 1].time,
    ).toBe(BREAK);
  });

  it("does nothing on a bar that has not closed", () => {
    const state = createState(SETTINGS, "open");
    feed(state, SETTINGS, [...WARMUP, ...BULL_BREAK.slice(0, -1)], bookOf());
    const last = BULL_BREAK[BULL_BREAK.length - 1];
    institutionalOrderBlocksIndicator.onBar(
      context(
        state,
        makeBar(BREAK, last.h, last.l, last.c, false),
        SETTINGS,
        bookOf(),
      ),
    );
    expect(drawnBoxes("open")).toHaveLength(0);
  });

  it("creates its box slots once, up to the classic cap, and survives the shared replay harness", () => {
    createState(SETTINGS, "cap");
    expect(
      handlesForOwners(["cap"]).filter((record) => record.kind === "box"),
    ).toHaveLength(DEFAULT_MAX_ORDER_BLOCKS);
    const bars = [...WARMUP, ...BULL_BREAK].map((c, i) =>
      makeBar(T0 + i * STEP, c.h, c.l, c.c),
    );
    expect(() =>
      replayBars(
        institutionalOrderBlocksIndicator,
        bars,
        institutionalOrderBlocksIndicator.defaultSettings,
      ),
    ).not.toThrow();
  });
});
