import { describe, expect, it, vi } from "vitest";
import {
  DeltaProfilePrimitive,
  DEFAULT_DELTA_PROFILE_SETTINGS,
} from "../deltaProfilePrimitive";
import type { ProfileFrame } from "../../../../types/frames";
import { MAX_LABELLED_HISTORICAL_PROFILES } from "../../volume-profile/profileLevelLabels";

/** The live chart's own panel colour and the dark historical one: the two
 * backgrounds a translucent bin's value ink has to work against. */
const LIVE_PANEL = "#f2efe6";
const HISTORICAL_PANEL = "#0c0c0c";

/** The fake chart's readback of `layout.background`, which the primitive uses
 * to composite a bin's translucent fill before choosing its value ink. */
function chartOptions(background: string) {
  return { layout: { background: { type: "solid", color: background } } };
}

function fakeCanvasTarget() {
  const fillRectCalls: Array<{ x: number; y: number; w: number; h: number }> =
    [];
  const strokeCalls: number[] = [];
  const lineDashCalls: number[][] = [];
  const textCalls: Array<{
    text: string;
    x: number;
    y: number;
    fill: string;
    align: string;
  }> = [];
  const plateCalls: Array<{ x: number; y: number; w: number; h: number }> = [];
  const fillCalls: string[] = [];
  const saveStack: Array<Record<string, unknown>> = [];
  const STYLE_KEYS = [
    "fillStyle",
    "strokeStyle",
    "lineWidth",
    "font",
    "textAlign",
    "textBaseline",
  ] as const;
  const context = {
    save: () => {
      saveStack.push(
        Object.fromEntries(
          STYLE_KEYS.map((k) => [k, (context as Record<string, unknown>)[k]]),
        ),
      );
    },
    restore: () => {
      const top = saveStack.pop();
      if (top)
        for (const k of STYLE_KEYS)
          (context as Record<string, unknown>)[k] = top[k];
    },
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    font: "",
    textAlign: "",
    textBaseline: "",
    fillRect: (x: number, y: number, w: number, h: number) =>
      fillRectCalls.push({ x, y, w, h }),
    setLineDash: (dash: number[]) => lineDashCalls.push(dash),
    fillText: (text: string, x: number, y: number) =>
      textCalls.push({
        text,
        x,
        y,
        fill: context.fillStyle,
        align: context.textAlign,
      }),
    measureText: (text: string) => ({ width: text.length * 6 }),
    roundRect: (x: number, y: number, w: number, h: number) =>
      plateCalls.push({ x, y, w, h }),
    fill: () => fillCalls.push(context.fillStyle),
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => strokeCalls.push(1),
  };
  return {
    fillRectCalls,
    strokeCalls,
    lineDashCalls,
    textCalls,
    plateCalls,
    fillCalls,
    context,
    saveStack,
    useMediaCoordinateSpace: (
      callback: (scope: { context: typeof context }) => void,
    ) => callback({ context }),
  };
}

/** Draws every pane view into one target. Bars route through whichever of the
 * two bar views matches their onTop tag, so a single-view lookup can see
 * nothing for one of the modes. */
function drawAllViews(primitive: DeltaProfilePrimitive) {
  const target = fakeCanvasTarget();
  for (const view of primitive.paneViews())
    view.renderer()?.draw?.(target as never);
  return target;
}

/** Reads the alpha channel out of an "rgba(r,g,b,a)" fill. */
function alphaOf(fill: string): number {
  return Number(/rgba\([^)]*,\s*([0-9.]+)\)$/.exec(fill)?.[1]);
}

/** The rgb triple of a fill, with the alpha stripped -- so two fills can be
 * compared for hue alone. */
function rgbOf(fill: string): string {
  return fill.replace(/,[^,]*\)$/, ")");
}

function fakeTimeScale({ hasPoints = true, widthPx = 800, originPx = 0 } = {}) {
  return {
    timeToCoordinate: (time: number) =>
      hasPoints && Number.isInteger(time) ? time * 10 + originPx : null,
    timeToIndex: (time: number, findNearest?: boolean) => {
      if (!hasPoints) return null;
      if (Number.isInteger(time)) return time;
      return findNearest ? Math.round(time) : null;
    },
    logicalToCoordinate: (index: number) => index * 10 + originPx,
    width: () => widthPx,
  };
}

/** The fixture profile's row width: how tall one price band is, in price. */
const ROW_WIDTH = 2;

// Net-delta fixture. Per-bucket delta (buy - sell) drives everything now:
//   100 -> +8, 102 -> +16 (POC), 104 -> -4.
// |delta| weights 8/16/4 total 28; at the default 70% the target is 19.6, so
// the POC's 16 pulls in the heavier neighbour below (8 > 4) -- the delta value
// area is buckets 100..102, leaving 104 outside it. The frame's own
// volume-based poc/vah/val are ignored by the renderer, which derives delta
// levels from the buckets instead.
const PROFILE: ProfileFrame = {
  type: "profile",
  provider: "BINANCE",
  symbol: "BTC-USDT",
  marketKind: "SPOT",
  mode: "continuous",
  period_start_ts: 1000,
  period_end_ts: null,
  row_width: 2,
  delivery_scope: "LIVE",
  history_request_id: null,
  buckets: [
    {
      price: 100,
      volume: 8,
      buy_volume: 8,
      sell_volume: 0,
      single_print: false,
    },
    {
      price: 102,
      volume: 20,
      buy_volume: 18,
      sell_volume: 2,
      single_print: false,
    },
    {
      price: 104,
      volume: 4,
      buy_volume: 0,
      sell_volume: 4,
      single_print: false,
    },
  ],
  poc_price: 102,
  vah_price: 102,
  val_price: 100,
};

/** A fixture whose single bucket's |delta| alone clears the 70% target, so the
 * delta value area collapses onto one price (one VAH/VAL line, not two). Its
 * first bucket is deliberately balanced, proving a zero-delta bucket draws no
 * bar. */
const COLLAPSED_VA_PROFILE: ProfileFrame = {
  ...PROFILE,
  buckets: [
    {
      price: 100,
      volume: 2,
      buy_volume: 1,
      sell_volume: 1,
      single_print: false,
    },
    {
      price: 102,
      volume: 100,
      buy_volume: 100,
      sell_volume: 0,
      single_print: false,
    },
  ],
};

function attach(
  primitive: DeltaProfilePrimitive,
  timeScaleOverrides: Parameters<typeof fakeTimeScale>[0] = {},
  background: string = LIVE_PANEL,
) {
  const requestUpdate = vi.fn();
  primitive.attached({
    chart: {
      timeScale: () => fakeTimeScale(timeScaleOverrides),
      options: () => chartOptions(background),
    },
    series: { priceToCoordinate: (price: number) => price * 2 },
    requestUpdate,
  } as never);
  return requestUpdate;
}

/** True when a bar occupies exactly the price band [price, price + rowWidth].
 *
 * A bucket's price is the band's LOWER edge, so a bin must cover that band.
 * Asserting the pair of edges rather than a single literal keeps the check
 * independent of which way the price axis points (yTop is the smaller pixel
 * value either way). Centring a bin on its price puts one edge half a row out
 * and fails this. */
function occupiesBand(
  bar: { yTop: number; yBottom: number },
  price: number,
  rowWidth: number,
): boolean {
  return (
    bar.yTop === Math.min(price, price + rowWidth) * 2 &&
    bar.yBottom === Math.max(price, price + rowWidth) * 2
  );
}

/** The developing fixture's period starts at x 10, inside the 110 px bar
 * budget, so its zero line sits at the budget floor (x 110): a full-budget
 * net-sell bar still ends on the pane at x 0. */
const DEVELOPING_AXIS_X = DEFAULT_DELTA_PROFILE_SETTINGS.maxBarWidthPx;

describe("DeltaProfilePrimitive", () => {
  it("draws one signed bar per bucket: net buy extends right of the zone's start line, net sell left", () => {
    const primitive = new DeltaProfilePrimitive();
    attach(primitive);
    primitive.setProfile(PROFILE);
    primitive.updateAllViews();

    // The zero line is the developing axis (DEVELOPING_AXIS_X). PROFILE deltas
    // are +8 / +16 / -4, so two bars grow right and one grows left.
    expect(primitive.renderBars).toHaveLength(3);
    const buyBars = primitive.renderBars.filter(
      (bar) => bar.x1 === DEVELOPING_AXIS_X,
    );
    const sellBars = primitive.renderBars.filter(
      (bar) => bar.x2 === DEVELOPING_AXIS_X,
    );
    expect(buyBars).toHaveLength(2);
    expect(sellBars).toHaveLength(1);
    for (const bar of buyBars) expect(bar.x2).toBeGreaterThan(DEVELOPING_AXIS_X);
    expect(sellBars[0].x1).toBeLessThan(DEVELOPING_AXIS_X);
  });

  it("scales net-delta length by |delta| against the profile's max SIDE volume, over the full bar budget", () => {
    const primitive = new DeltaProfilePrimitive();
    attach(primitive);
    primitive.setProfile(PROFILE);
    primitive.updateAllViews();

    // maxSideVolume = 18 (bucket 102's buy_volume). Delta +16 -> 16/18 of the
    // full budget, not half of it; delta -4 -> 4/18.
    const budget = DEFAULT_DELTA_PROFILE_SETTINGS.maxBarWidthPx;
    const poc = primitive.renderBars.find(
      (bar) => bar.x1 === DEVELOPING_AXIS_X && bar.x2 - bar.x1 > 50,
    )!;
    expect(poc.x2 - poc.x1).toBeCloseTo((16 / 18) * budget, 5);
    const sellBar = primitive.renderBars.find(
      (bar) => bar.x2 === DEVELOPING_AXIS_X,
    )!;
    expect(sellBar.x2 - sellBar.x1).toBeCloseTo((4 / 18) * budget, 5);
  });

  // A net-sell bar reaches LEFT of the zero line by up to the whole bar
  // budget; a developing axis never sits closer to the pane's left edge than
  // that budget, so the longest net-sell bar ends exactly at x 0.
  it("lets a net-sell bar extend left of the zone's start line, by at most the bar budget", () => {
    const primitive = new DeltaProfilePrimitive();
    attach(primitive);
    primitive.setProfile({
      ...PROFILE,
      buckets: [
        {
          price: 100,
          volume: 1000,
          buy_volume: 0,
          sell_volume: 1000,
          single_print: false,
        },
      ],
    });
    primitive.updateAllViews();

    // Axis = 110 (the budget floor), |delta| = maxSideVolume -> full budget
    // leftward, so the furthest it reaches back is 110 - 110 = 0.
    const sellBar = primitive.renderBars.find(
      (bar) => bar.x2 === DEVELOPING_AXIS_X,
    )!;
    expect(sellBar.x1).toBeCloseTo(0, 5);
  });

  it("draws nothing for a bucket whose buy and sell volumes net to zero", () => {
    const primitive = new DeltaProfilePrimitive();
    attach(primitive);
    primitive.setProfile({
      ...PROFILE,
      buckets: [
        ...PROFILE.buckets,
        {
          price: 106,
          volume: 12,
          buy_volume: 6,
          sell_volume: 6,
          single_print: false,
        },
      ],
    });
    primitive.updateAllViews();

    // The balanced bucket contributes no bar at all -- not a zero-width one.
    expect(primitive.renderBars).toHaveLength(3);
    expect(
      primitive.renderBars.some((bar) => occupiesBand(bar, 106, ROW_WIDTH)),
    ).toBe(false);
  });

  it("colours a net-buy bar with the buy hue and a net-sell bar with the sell hue", () => {
    const primitive = new DeltaProfilePrimitive();
    attach(primitive);
    primitive.setProfile(PROFILE);
    primitive.updateAllViews();

    const rgbOf = (fill: string) => fill.replace(/,[^,]*\)$/, ")");
    const [low, poc, sell] = primitive.renderBars;
    expect(rgbOf(poc.fill)).toBe(rgbOf(low.fill));
    expect(rgbOf(sell.fill)).not.toBe(rgbOf(low.fill));
    // One signed fill per bar -- three buckets, three fills.
    expect(drawAllViews(primitive).fillRectCalls).toHaveLength(3);
  });

  it("scales every bar off one shared max-side-volume across the whole profile", () => {
    const primitive = new DeltaProfilePrimitive();
    attach(primitive);
    primitive.setProfile(PROFILE);
    primitive.updateAllViews();

    // The POC's +16 is the widest bar; every other bar is seen against it.
    const poc = primitive.renderBars.find(
      (bar) => bar.x1 === DEVELOPING_AXIS_X && bar.x2 - bar.x1 > 50,
    )!;
    const widest = Math.max(
      ...primitive.renderBars.map((bar) => bar.x2 - bar.x1),
    );
    expect(poc.x2 - poc.x1).toBeCloseTo(widest, 5);
  });

  it("registers the lines BEFORE the on-top bars, so bins paint above POC/VAH/VAL", () => {
    const primitive = new DeltaProfilePrimitive();
    attach(primitive);
    primitive.setProfile(PROFILE);
    primitive.updateAllViews();

    // lightweight-charts paints pane views in registration order within a
    // zOrder, and every bar is onTop, so the line view must come first or it
    // would draw over the bins.
    const topOrder = primitive
      .paneViews()
      .filter((view) => view.zOrder?.() === "top")
      .map((view) => {
        const target = fakeCanvasTarget();
        view.renderer()?.draw?.(target as never);
        return {
          fillRects: target.fillRectCalls.length,
          strokes: target.strokeCalls.length,
        };
      });
    const lineIndex = topOrder.findIndex((entry) => entry.strokes > 0);
    const barIndex = topOrder.findIndex((entry) => entry.fillRects > 0);
    expect(lineIndex).toBeGreaterThanOrEqual(0);
    expect(barIndex).toBeGreaterThanOrEqual(0);
    expect(lineIndex).toBeLessThan(barIndex);
  });

  it("tags a Per-Candle profile's bars onTop, so they are not hidden behind an opaque candle body", () => {
    const primitive = new DeltaProfilePrimitive();
    attach(primitive);
    primitive.setProfile({ ...PROFILE, mode: "per_candle" });
    primitive.updateAllViews();

    expect(primitive.renderBars.length).toBeGreaterThan(0);
    for (const bar of primitive.renderBars) expect(bar.onTop).toBe(true);
  });

  it("tags a Continuous profile's bars onTop too, so the overlay is not tied to the mode", () => {
    const primitive = new DeltaProfilePrimitive();
    attach(primitive);
    primitive.setProfile({ ...PROFILE, mode: "continuous" });
    primitive.updateAllViews();

    expect(primitive.renderBars.length).toBeGreaterThan(0);
    for (const bar of primitive.renderBars) expect(bar.onTop).toBe(true);
  });

  it("actually routes every bar through the top zOrder pane view, not just tags them", () => {
    const primitive = new DeltaProfilePrimitive();
    attach(primitive);
    primitive.setProfile({
      ...PROFILE,
      mode: "per_candle",
      period_start_ts: 1000,
      period_end_ts: null,
    });
    primitive.setHistoricalProfiles([
      {
        ...PROFILE,
        mode: "fixed_range",
        period_start_ts: 4000,
        period_end_ts: 6000,
        buckets: [
          {
            price: 200,
            volume: 9,
            buy_volume: 9,
            sell_volume: 0,
            single_print: false,
          },
        ],
        poc_price: 200,
        vah_price: 200,
        val_price: 200,
      },
    ]);
    primitive.updateAllViews();

    const barCount = primitive.renderBars.length;
    expect(barCount).toBeGreaterThan(0);

    const drawnCounts = primitive.paneViews().map((view) => {
      const target = fakeCanvasTarget();
      view.renderer()?.draw?.(target as never);
      return {
        zOrder: view.zOrder?.(),
        fillRects: target.fillRectCalls.length,
        strokes: target.strokeCalls.length,
      };
    });

    // Every bar is onTop now, so the bottom bar view paints nothing and the top
    // bar view carries them all.
    const bottomView = drawnCounts.find((entry) => entry.zOrder === "bottom");
    expect(bottomView?.fillRects).toBe(0);
    const topBarViews = drawnCounts.filter(
      (entry) => entry.zOrder === "top" && entry.fillRects > 0,
    );
    expect(topBarViews).toHaveLength(1);
    expect(topBarViews[0].fillRects).toBe(barCount);
  });

  it("draws the POC dashed while developing and solid once closed, while VAH/VAL keep their own style", () => {
    const developing = new DeltaProfilePrimitive();
    attach(developing);
    developing.setProfile(PROFILE);
    developing.updateAllViews();
    const developingPoc = developing.renderLines.find(
      (line) => line.lineWidth > 1,
    )!;
    expect(developingPoc.style).toBe("dashed");
    for (const line of developing.renderLines.filter(
      (line) => line.lineWidth === 1,
    )) {
      expect(line.style).toBe("dashed");
    }

    const closed = new DeltaProfilePrimitive();
    attach(closed);
    closed.setProfile({ ...PROFILE, period_end_ts: 3000 });
    closed.updateAllViews();
    for (const line of closed.renderLines) {
      expect(line.x2).toBe(30);
    }
    expect(closed.renderLines.find((line) => line.lineWidth > 1)!.style).toBe(
      "solid",
    );
    // VAH/VAL are user-styled, so they stay dashed regardless of the period's
    // own state.
    for (const line of closed.renderLines.filter(
      (line) => line.lineWidth === 1,
    )) {
      expect(line.style).toBe("dashed");
    }
  });

  it("honours the VAH/VAL line style setting -- dotted, solid, and dashed each reach the canvas", () => {
    const cases: readonly {
      style: "solid" | "dashed" | "dotted";
      dash: number[];
    }[] = [
      { style: "solid", dash: [] },
      { style: "dashed", dash: [6, 4] },
      { style: "dotted", dash: [2, 2] },
    ];
    for (const { style, dash } of cases) {
      const primitive = new DeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.setSettings({
        ...DEFAULT_DELTA_PROFILE_SETTINGS,
        showPocLine: false,
        vahValStyle: style,
      });
      primitive.updateAllViews();

      expect(primitive.renderLines).toHaveLength(2);
      for (const line of primitive.renderLines) {
        expect(line.style).toBe(style);
      }
      expect(drawAllViews(primitive).lineDashCalls).toEqual([dash, dash]);
    }
  });

  it("honours the value area percent setting -- the delta value area grows as the percent rises", () => {
    // |delta| 8 / 16 / 4 sums to 28. At 20% (5.6) the POC's 16 alone clears the
    // target, collapsing the area onto one price; at 70% (19.6) it must pull in
    // the heavier neighbour below (8 > 4), spanning buckets 100..102.
    const narrow = new DeltaProfilePrimitive();
    attach(narrow);
    narrow.setProfile(PROFILE);
    narrow.setSettings({
      ...DEFAULT_DELTA_PROFILE_SETTINGS,
      showPocLine: false,
      valueAreaPercent: 0.2,
    });
    narrow.updateAllViews();
    expect(narrow.renderLines).toHaveLength(1);

    const wide = new DeltaProfilePrimitive();
    attach(wide);
    wide.setProfile(PROFILE);
    wide.setSettings({
      ...DEFAULT_DELTA_PROFILE_SETTINGS,
      showPocLine: false,
      valueAreaPercent: 0.7,
    });
    wide.updateAllViews();
    const thinLines = wide.renderLines.filter((line) => line.lineWidth === 1);
    expect(thinLines).toHaveLength(2);
    expect(thinLines.some((line) => line.y === 100 * 2)).toBe(true);
  });

  it("dims every bar fill while developing, relative to a closed period at the same settings", () => {
    const developing = new DeltaProfilePrimitive();
    attach(developing);
    developing.setProfile(PROFILE);
    developing.updateAllViews();

    const closed = new DeltaProfilePrimitive();
    attach(closed);
    closed.setProfile({ ...PROFILE, period_end_ts: 3000 });
    closed.updateAllViews();

    expect(developing.renderBars.length).toBeGreaterThan(0);
    expect(closed.renderBars.length).toBe(developing.renderBars.length);
    expect(developing.renderBars[0].fill).not.toBe(closed.renderBars[0].fill);
  });

  it("draws a single VAH/VAL line, not two overlapping ones, when the value area collapses to one price", () => {
    const primitive = new DeltaProfilePrimitive();
    attach(primitive);
    primitive.setProfile(COLLAPSED_VA_PROFILE);
    primitive.updateAllViews();

    const thinLines = primitive.renderLines.filter(
      (line) => line.lineWidth === 1,
    );
    expect(thinLines).toHaveLength(1);
  });

  it("derives the delta POC and value area from |delta|, ignoring the frame's volume-based levels", () => {
    const primitive = new DeltaProfilePrimitive();
    attach(primitive);
    // The frame claims poc 100 / vah 100 / val 100 (its own gross-volume
    // levels). The delta levels are 102 (max |delta|) with the area reaching
    // down to 100, so the drawn POC line must be at 102, not 100.
    primitive.setProfile({
      ...PROFILE,
      poc_price: 100,
      vah_price: 100,
      val_price: 100,
    });
    primitive.updateAllViews();

    const pocLine = primitive.renderLines.find((line) => line.lineWidth > 1)!;
    expect(pocLine.y).toBe((102 + ROW_WIDTH / 2) * 2);
    expect(primitive.renderLines.some((line) => line.y === 100 * 2)).toBe(true);
  });

  it("showPocLine and showValueAreaLines each independently gate their own lines", () => {
    const primitive = new DeltaProfilePrimitive();
    attach(primitive);
    primitive.setProfile(PROFILE);
    primitive.setSettings({
      ...DEFAULT_DELTA_PROFILE_SETTINGS,
      showPocLine: false,
    });
    primitive.updateAllViews();
    expect(primitive.renderLines).toHaveLength(2);

    primitive.setSettings({
      ...DEFAULT_DELTA_PROFILE_SETTINGS,
      showValueAreaLines: false,
    });
    primitive.updateAllViews();
    expect(primitive.renderLines).toHaveLength(1);
  });

  // Bin gradient. Each bar fades against the profile's busiest side, so its own
  // net-delta weight is readable from tint as well as from bar length.
  describe("bin opacity gradient follows |delta|", () => {
    it("renders the largest-magnitude delta most opaque and every smaller one fainter", () => {
      const primitive = new DeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.setSettings({
        ...DEFAULT_DELTA_PROFILE_SETTINGS,
        developingOpacity: 1,
      });
      primitive.updateAllViews();

      // |delta| 8 / 16 / 4 against maxSideVolume 18: the POC (+16) is the most
      // opaque, the -4 bucket the least.
      const poc = primitive.renderBars.find(
        (bar) => bar.x1 === DEVELOPING_AXIS_X && bar.x2 - bar.x1 > 50,
      )!;
      const low = primitive.renderBars.find(
        (bar) => bar.x1 === DEVELOPING_AXIS_X && bar.x2 - bar.x1 < 50,
      )!;
      const sell = primitive.renderBars.find(
        (bar) => bar.x2 === DEVELOPING_AXIS_X,
      )!;
      expect(alphaOf(poc.fill)).toBeGreaterThan(alphaOf(low.fill));
      expect(alphaOf(low.fill)).toBeGreaterThan(alphaOf(sell.fill));
      // The 0.5 floor: the smallest bar stays visible instead of vanishing.
      expect(alphaOf(sell.fill)).toBeGreaterThan(0);
    });

    it("fades buy and sell bars by their own |delta|, so opposite signs can share an alpha", () => {
      const primitive = new DeltaProfilePrimitive();
      attach(primitive);
      // +99 and -99 against maxSideVolume 100: equal magnitude, opposite signs.
      primitive.setProfile({
        ...PROFILE,
        buckets: [
          {
            price: 100,
            volume: 101,
            buy_volume: 100,
            sell_volume: 1,
            single_print: false,
          },
          {
            price: 102,
            volume: 101,
            buy_volume: 1,
            sell_volume: 100,
            single_print: false,
          },
        ],
      });
      primitive.setSettings({
        ...DEFAULT_DELTA_PROFILE_SETTINGS,
        developingOpacity: 1,
      });
      primitive.updateAllViews();

      expect(primitive.renderBars).toHaveLength(2);
      const [buy, sell] = primitive.renderBars;
      expect(alphaOf(buy.fill)).toBeCloseTo(alphaOf(sell.fill), 5);
      // Same alpha, different hue -- the sign is still readable.
      expect(rgbOf(buy.fill)).not.toBe(rgbOf(sell.fill));
    });
  });

  // A bin inside the delta value area takes the brighter tint AND the vivid,
  // near-opaque band; a bin outside it takes the plain tint and the dim band.
  describe("value-area bins are more intense than bins outside it", () => {
    // |delta| 10 / 20 / 10 (total 40). At 70% the target is 28, so the POC (102)
    // plus its equal-weight neighbour above (104) make the value area, leaving
    // 100 outside it. All three are net-buy so the hue difference is the tint,
    // not the sign.
    const BUY_PROFILE = {
      ...PROFILE,
      buckets: [
        {
          price: 100,
          volume: 10,
          buy_volume: 10,
          sell_volume: 0,
          single_print: false,
        },
        {
          price: 102,
          volume: 20,
          buy_volume: 20,
          sell_volume: 0,
          single_print: false,
        },
        {
          price: 104,
          volume: 10,
          buy_volume: 10,
          sell_volume: 0,
          single_print: false,
        },
      ],
    };

    it("draws an in-value-area bin at the vivid band and an equal-|delta| outside bin dimmer", () => {
      const primitive = new DeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(BUY_PROFILE);
      primitive.setSettings({
        ...DEFAULT_DELTA_PROFILE_SETTINGS,
        developingOpacity: 1,
      });
      primitive.updateAllViews();

      const [outside, poc, inVa] = primitive.renderBars;
      // Same |delta| (10), so the only opacity difference is the band itself.
      expect(alphaOf(inVa.fill)).toBeGreaterThan(alphaOf(outside.fill));
      // Both stay on the buy hue -- value-area membership is not a sign flip,
      // but the inside tint is its own, brighter colour.
      expect(rgbOf(inVa.fill)).not.toBe(rgbOf(outside.fill));
      expect(rgbOf(poc.fill)).toBe(rgbOf(inVa.fill));
      expect(rgbOf(inVa.fill)).not.toBe(
        rgbOf(DEFAULT_DELTA_PROFILE_SETTINGS.buyColor),
      );
    });

    it("uses the sell-side value-area tint for a net-sell bucket inside the area", () => {
      const primitive = new DeltaProfilePrimitive();
      attach(primitive);
      // The POC is a large net SELL bucket, so it sits inside the value area in
      // the sell hue's brighter variant.
      primitive.setProfile({
        ...PROFILE,
        buckets: [
          {
            price: 100,
            volume: 4,
            buy_volume: 4,
            sell_volume: 0,
            single_print: false,
          },
          {
            price: 102,
            volume: 40,
            buy_volume: 0,
            sell_volume: 40,
            single_print: false,
          },
        ],
      });
      primitive.setSettings({
        ...DEFAULT_DELTA_PROFILE_SETTINGS,
        developingOpacity: 1,
      });
      primitive.updateAllViews();

      const poc = primitive.renderBars.find(
        (bar) => bar.x2 === DEVELOPING_AXIS_X,
      )!;
      expect(rgbOf(poc.fill)).toBe(
        rgbOf(
          `rgba(${Number.parseInt(
            DEFAULT_DELTA_PROFILE_SETTINGS.sellValueAreaColor.slice(1, 3),
            16,
          )},${Number.parseInt(
            DEFAULT_DELTA_PROFILE_SETTINGS.sellValueAreaColor.slice(3, 5),
            16,
          )},${Number.parseInt(
            DEFAULT_DELTA_PROFILE_SETTINGS.sellValueAreaColor.slice(5, 7),
            16,
          )},${alphaOf(poc.fill)})`,
        ),
      );
    });
  });

  // Each bin prints its own signed net delta centred inside its box, at a size
  // the box can hold -- hidden rather than overflowing when too small.
  describe("bin value text", () => {
    /** A tall price axis, so every fixture bin is large enough to hold a value
     * -- the default fixture's 4px bands cannot. */
    function attachRoomy(
      primitive: DeltaProfilePrimitive,
      background: string = LIVE_PANEL,
    ): void {
      primitive.attached({
        chart: {
          timeScale: () => fakeTimeScale(),
          options: () => chartOptions(background),
        },
        series: { priceToCoordinate: (price: number) => price * 6 },
        requestUpdate: vi.fn(),
      } as never);
    }

    it("aligns each value to the outside edge of its bar: buy left, sell right", () => {
      const primitive = new DeltaProfilePrimitive();
      attachRoomy(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      const binValues = drawAllViews(primitive).textCalls.filter((call) =>
        /^[+-][\d,]+$/.test(call.text),
      );
      // PROFILE deltas: 100 -> +8, 102 -> +16, 104 -> -4.
      expect(binValues.map((call) => call.text)).toEqual(["+8", "+16", "-4"]);
      for (const [index, bar] of primitive.renderBars.entries()) {
        // Bars are anchored at the developing axis (DEVELOPING_AXIS_X): a
        // net-buy bar begins there and grows right; a net-sell bar ends there.
        const isBuy = bar.x1 === DEVELOPING_AXIS_X;
        expect(binValues[index].align).toBe(isBuy ? "left" : "right");
        // Anchored just inside the bar's own zero-line edge, vertically centred.
        expect(binValues[index].x).toBeCloseTo(
          isBuy ? bar.x1 + 2 : bar.x2 - 2,
          5,
        );
        expect(binValues[index].y).toBeCloseTo((bar.yTop + bar.yBottom) / 2, 5);
      }
    });

    it("prints no per-bin values once closed session zones exceed the legible count", () => {
      const primitive = new DeltaProfilePrimitive();
      attachRoomy(primitive);
      primitive.setHistoricalProfiles(
        Array.from(
          { length: MAX_LABELLED_HISTORICAL_PROFILES + 1 },
          (_unused, index) => ({
            ...PROFILE,
            delivery_scope: "HISTORICAL" as const,
            period_start_ts: 1000 + index * 2000,
            period_end_ts: 12000 + index * 2000,
          }),
        ),
      );
      primitive.updateAllViews();

      expect(primitive.renderBars.length).toBeGreaterThan(0);
      expect(
        drawAllViews(primitive).textCalls.filter((call) =>
          /^[+-][\d,]+$/.test(call.text),
        ),
      ).toEqual([]);
    });

    it("counts only closed session zones toward the legible count, so a fixed range beside them keeps their values", () => {
      const primitive = new DeltaProfilePrimitive();
      attachRoomy(primitive);
      primitive.setHistoricalProfiles([
        ...Array.from(
          { length: MAX_LABELLED_HISTORICAL_PROFILES },
          (_unused, index) => ({
            ...PROFILE,
            delivery_scope: "HISTORICAL" as const,
            period_start_ts: 1000 + index * 2000,
            period_end_ts: 12000 + index * 2000,
          }),
        ),
        {
          ...PROFILE,
          delivery_scope: "FIXED_RANGE" as const,
          period_start_ts: 1000 + MAX_LABELLED_HISTORICAL_PROFILES * 2000,
          period_end_ts: 12000 + MAX_LABELLED_HISTORICAL_PROFILES * 2000,
        },
      ]);
      primitive.updateAllViews();

      const binValues = drawAllViews(primitive).textCalls.filter((call) =>
        /^[+-][\d,]+$/.test(call.text),
      );
      // Three bins a profile, every one of the five labelled.
      expect(binValues).toHaveLength(3 * (MAX_LABELLED_HISTORICAL_PROFILES + 1));
    });

    it("keeps the developing profile's per-bin values when the closed zones beside it are past the legible count", () => {
      const primitive = new DeltaProfilePrimitive();
      attachRoomy(primitive);
      primitive.setProfile(PROFILE);
      primitive.setHistoricalProfiles(
        Array.from(
          { length: MAX_LABELLED_HISTORICAL_PROFILES + 1 },
          (_unused, index) => ({
            ...PROFILE,
            delivery_scope: "HISTORICAL" as const,
            period_start_ts: 1000 + index * 2000,
            period_end_ts: 12000 + index * 2000,
          }),
        ),
      );
      primitive.updateAllViews();

      const binValues = drawAllViews(primitive).textCalls.filter((call) =>
        /^[+-][\d,]+$/.test(call.text),
      );
      expect(binValues.map((call) => call.text)).toEqual(["+8", "+16", "-4"]);
    });

    it("keeps per-bin values on a few closed session zones", () => {
      const primitive = new DeltaProfilePrimitive();
      attachRoomy(primitive);
      primitive.setHistoricalProfiles([
        {
          ...PROFILE,
          delivery_scope: "HISTORICAL",
          period_start_ts: 1000,
          period_end_ts: 12000,
        },
      ]);
      primitive.updateAllViews();

      const binValues = drawAllViews(primitive).textCalls.filter((call) =>
        /^[+-][\d,]+$/.test(call.text),
      );
      expect(binValues.map((call) => call.text)).toEqual(["+8", "+16", "-4"]);
    });

    it("still prints per-bin values for a fixed-range zone", () => {
      const primitive = new DeltaProfilePrimitive();
      attachRoomy(primitive);
      primitive.setHistoricalProfiles([
        {
          ...PROFILE,
          delivery_scope: "FIXED_RANGE",
          period_start_ts: 1000,
          period_end_ts: 12000,
        },
      ]);
      primitive.updateAllViews();

      const binValues = drawAllViews(primitive).textCalls.filter((call) =>
        /^[+-][\d,]+$/.test(call.text),
      );
      expect(binValues.map((call) => call.text)).toEqual(["+8", "+16", "-4"]);
    });

    it("skips a bin too small to hold its value, drawing no overflowing text", () => {
      const primitive = new DeltaProfilePrimitive();
      // The default axis gives 4px-tall bands -- too short for the minimum font.
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      expect(primitive.renderBars).toHaveLength(3);
      expect(
        drawAllViews(primitive).textCalls.filter((call) =>
          /^[+-][\d,]+$/.test(call.text),
        ),
      ).toEqual([]);
    });

    it("inks a faint outside-value-area bin for the panel it is drawn on", () => {
      const faintestInk = (background: string) => {
        const primitive = new DeltaProfilePrimitive();
        attachRoomy(primitive, background);
        primitive.setProfile(PROFILE);
        primitive.setSettings({
          ...DEFAULT_DELTA_PROFILE_SETTINGS,
          developingOpacity: 1,
        });
        primitive.updateAllViews();
        const values = drawAllViews(primitive).textCalls.filter((call) =>
          /^[+-][\d,]+$/.test(call.text),
        );
        // Fixture deltas are +8, +16, -4, so the last bin is the smallest
        // |delta| and therefore the one at the outside-value-area minimum
        // alpha. The classic "the two sides must differ" check no longer
        // holds: over a light panel a faded magenta bin really is pale, so it
        // correctly takes the same near-black ink a faded teal bin does.
        return values[values.length - 1].fill;
      };
      expect(faintestInk(LIVE_PANEL)).toBe("#0a0a0a");
      expect(faintestInk(HISTORICAL_PANEL)).toBe("#ffffff");
    });
  });

  // Level labels, matching the Volume Profile's own -- same text, same
  // placement, same developing-only rule.
  describe("level labels on the developing profile", () => {
    it("labels the delta POC with its price and signed net delta, and both value-area edges with their prices", () => {
      const primitive = new DeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      // Delta POC bucket 102, net delta +16; delta value area 100..102. The
      // levels are delta-derived, so each is prefixed with "Δ" -- a bare
      // "POC" on this terminal means the most-traded volume price.
      const texts = primitive.renderLabels.map((label) => label.text);
      expect(texts).toContain("Δ POC: 102.00 | +16");
      expect(texts).toContain("Δ VAH: 102.00");
      expect(texts).toContain("Δ VAL: 100.00");
    });

    it("signs the POC delta, so a net-sell POC reads negative rather than as a bare magnitude", () => {
      const primitive = new DeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile({
        ...PROFILE,
        buckets: [
          {
            price: 100,
            volume: 6,
            buy_volume: 1,
            sell_volume: 5,
            single_print: false,
          },
          {
            price: 102,
            volume: 40,
            buy_volume: 2,
            sell_volume: 38,
            single_print: false,
          },
        ],
      });
      primitive.updateAllViews();

      expect(
        primitive.renderLabels.find((label) => label.text.startsWith("Δ POC"))!
          .text,
      ).toBe("Δ POC: 102.00 | -36");
    });

    it("keeps every label inside the pane, level with its own line", () => {
      const primitive = new DeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      const pocLabel = primitive.renderLabels.find((label) =>
        label.text.startsWith("Δ POC"),
      )!;
      const pocLine = primitive.renderLines.find((line) => line.lineWidth > 1)!;
      expect(pocLabel.y).toBe(pocLine.y);
      for (const label of primitive.renderLabels) {
        expect(label.x).toBeLessThan(800);
        expect(label.x).toBeGreaterThan(0);
      }
    });

    it("labels nothing once the period closes, and nothing for a historical zone", () => {
      const closed = new DeltaProfilePrimitive();
      attach(closed);
      closed.setProfile({ ...PROFILE, period_end_ts: 3000 });
      closed.updateAllViews();
      expect(closed.renderLabels).toEqual([]);

      const historical = new DeltaProfilePrimitive();
      attach(historical);
      historical.setHistoricalProfiles([
        { ...PROFILE, period_start_ts: 1000, period_end_ts: 3000 },
      ]);
      historical.updateAllViews();
      expect(historical.renderLabels).toEqual([]);
    });

    it("paints each label on an opaque plate so the line does not cross the text", () => {
      const primitive = new DeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      const target = drawAllViews(primitive);
      expect(target.plateCalls).toHaveLength(primitive.renderLabels.length);
      for (const fill of target.fillCalls) expect(fill).toBe("#ffffff");
      expect(target.textCalls.map((call) => call.text)).toEqual(
        primitive.renderLabels.map((label) => label.text),
      );
    });
  });

  it("a historical zone with no resolvable end renders nothing, rather than extending to the chart's full width", () => {
    const primitive = new DeltaProfilePrimitive();
    attach(primitive);
    primitive.setHistoricalProfiles([{ ...PROFILE, period_end_ts: null }]);
    primitive.updateAllViews();

    expect(primitive.renderBars).toEqual([]);
    expect(primitive.renderLines).toEqual([]);
  });

  // The bottom/top split happens once per primitive update, not once per browser
  // paint. A dense historical profile can hold thousands of rectangles, so
  // avoiding two full-array filters in every renderer call materially reduces
  // churn on the paint path -- while preserving exactly the layering contract
  // asserted below.
  it("layers the live profile alongside historical zones -- both render together", () => {
    const primitive = new DeltaProfilePrimitive();
    attach(primitive);
    primitive.setProfile(PROFILE);
    primitive.setHistoricalProfiles([
      {
        ...PROFILE,
        period_start_ts: 4000,
        period_end_ts: 6000,
        buckets: [
          {
            price: 200,
            volume: 9,
            buy_volume: 4,
            sell_volume: 5,
            single_print: false,
          },
        ],
        poc_price: 200,
        vah_price: 200,
        val_price: 200,
      },
    ]);
    primitive.updateAllViews();

    const liveBars = primitive.renderBars.filter((bar) =>
      occupiesBand(bar, 100, ROW_WIDTH),
    );
    const historicalBars = primitive.renderBars.filter(
      (bar) => bar.x1 === 40 || bar.x2 === 40,
    );
    expect(liveBars.length).toBeGreaterThan(0);
    expect(historicalBars.length).toBeGreaterThan(0);
  });

  it("clears stale render state when the profile is cleared or the primitive detaches", () => {
    const primitive = new DeltaProfilePrimitive();
    attach(primitive);
    primitive.setProfile(PROFILE);
    primitive.updateAllViews();
    expect(primitive.renderBars.length).toBeGreaterThan(0);

    primitive.setProfile(null);
    primitive.updateAllViews();
    expect(primitive.renderBars).toEqual([]);
    expect(primitive.renderLines).toEqual([]);

    primitive.setProfile(PROFILE);
    primitive.detached();
    primitive.updateAllViews();
    expect(primitive.renderBars).toEqual([]);
    expect(primitive.renderLines).toEqual([]);
  });

  it("renders nothing when the chart genuinely has no bar points at all to resolve any time against", () => {
    const primitive = new DeltaProfilePrimitive();
    attach(primitive, { hasPoints: false });
    primitive.setProfile(PROFILE);
    primitive.updateAllViews();
    expect(primitive.renderBars).toEqual([]);
    expect(primitive.renderLines).toEqual([]);
  });

  it("resolves an off-grid period timestamp instead of rendering nothing", () => {
    const primitive = new DeltaProfilePrimitive();
    attach(primitive);
    // A closed period, so its axis is its own start line: a developing axis
    // this close to the left edge sits at the bar-budget floor instead.
    primitive.setProfile({
      ...PROFILE,
      period_start_ts: 1300,
      period_end_ts: 3000,
    });
    primitive.updateAllViews();

    expect(primitive.renderBars.length).toBeGreaterThan(0);
    // 1300ms snaps to the nearest real bar (Math.round(1.3) = 1) -> x 10, the
    // same start line the exact-integer fixture resolves to.
    expect(
      primitive.renderBars.some((bar) => bar.x1 === 10 || bar.x2 === 10),
    ).toBe(true);
  });

  // L1L2-V2-087. Every pane primitive draws onto the same shared 2D context,
  // in attach order. One that assigns fillStyle/strokeStyle/lineWidth and
  // returns without restoring leaves them set for whatever draws next, so an
  // indicator's appearance depends on which other indicators happen to be
  // enabled -- the cross-indicator coupling Phase 18 existed to remove. The
  // two hand-written setLineDash([]) resets this replaced were the same fix
  // applied by hand to one property at a time.
  it("leaves the shared canvas context exactly as it found it, on every pane view", () => {
    const primitive = new DeltaProfilePrimitive();
    attach(primitive);
    primitive.setProfile({
      ...PROFILE,
      mode: "per_candle",
      period_start_ts: 1000,
      period_end_ts: null,
    });
    primitive.setHistoricalProfiles([
      {
        ...PROFILE,
        mode: "fixed_range",
        period_start_ts: 4000,
        period_end_ts: 6000,
        buckets: [
          {
            price: 200,
            volume: 9,
            buy_volume: 9,
            sell_volume: 0,
            single_print: false,
          },
        ],
        poc_price: 200,
        vah_price: 200,
        val_price: 200,
      },
    ]);
    primitive.updateAllViews();

    for (const view of primitive.paneViews()) {
      const target = fakeCanvasTarget();
      target.context.fillStyle = "#sentinelFill";
      target.context.strokeStyle = "#sentinelStroke";
      target.context.lineWidth = 99;

      view.renderer()?.draw?.(target as never);

      expect(target.context.fillStyle).toBe("#sentinelFill");
      expect(target.context.strokeStyle).toBe("#sentinelStroke");
      expect(target.context.lineWidth).toBe(99);
      expect(target.saveStack).toHaveLength(0);
    }
  });
});

describe("DeltaProfilePrimitive -- developing axis kept a bar budget from the chart's left edge", () => {
  /** A time axis shifted 50px left, so the fixture's session start (x = 10 on
   * the default axis) lands at x = -40: off the pane, which is the state that
   * used to paint the whole developing profile at a negative x and lose it. */
  const OFF_SCREEN = { originPx: -50 };

  it("keeps both halves on the pane: the axis sits at the bar budget and every net-sell bar starts at x >= 0", () => {
    const primitive = new DeltaProfilePrimitive();
    attach(primitive, OFF_SCREEN);
    primitive.setProfile(PROFILE);
    primitive.updateAllViews();

    // PROFILE deltas are +8 / +16 / -4, so two bars grow right and one left.
    expect(primitive.renderBars).toHaveLength(3);
    const buyBars = primitive.renderBars.filter(
      (bar) => bar.x1 === DEVELOPING_AXIS_X,
    );
    const sellBars = primitive.renderBars.filter(
      (bar) => bar.x2 === DEVELOPING_AXIS_X,
    );
    expect(buyBars).toHaveLength(2);
    expect(sellBars).toHaveLength(1);
    for (const bar of buyBars) expect(bar.x2).toBeGreaterThan(DEVELOPING_AXIS_X);
    for (const bar of primitive.renderBars) {
      expect(bar.x1).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps a full-budget net-sell bar on the pane, ending at x 0", () => {
    const primitive = new DeltaProfilePrimitive();
    attach(primitive, OFF_SCREEN);
    primitive.setProfile({
      ...PROFILE,
      buckets: [
        {
          price: 100,
          volume: 1000,
          buy_volume: 0,
          sell_volume: 1000,
          single_print: false,
        },
      ],
    });
    primitive.updateAllViews();

    const [sellBar] = primitive.renderBars;
    expect(sellBar.x2).toBe(DEVELOPING_AXIS_X);
    expect(sellBar.x1).toBeCloseTo(0, 5);
  });

  it("leaves an axis further in than the budget at its true session start", () => {
    const primitive = new DeltaProfilePrimitive();
    attach(primitive, { originPx: 200 });
    primitive.setProfile(PROFILE);
    primitive.updateAllViews();

    // Start x = 10 + 200 = 210, beyond the 110 floor, so nothing moves.
    expect(primitive.renderBars.filter((bar) => bar.x1 === 210)).toHaveLength(2);
    expect(primitive.renderBars.filter((bar) => bar.x2 === 210)).toHaveLength(1);
  });

  it("leaves a historical zone's axis at its true off-screen x in the same pass", () => {
    const primitive = new DeltaProfilePrimitive();
    attach(primitive, OFF_SCREEN);
    primitive.setProfile(PROFILE);
    primitive.setHistoricalProfiles([
      { ...PROFILE, period_start_ts: 1500, period_end_ts: 2500 },
    ]);
    primitive.updateAllViews();

    // The historical zone's axis (1500 snaps to bar 2) is 30px left of the
    // pane, so its bars straddle -30; the developing zone's straddle the floor.
    const bars = primitive.renderBars;
    expect(bars.filter((bar) => bar.x1 === DEVELOPING_AXIS_X)).toHaveLength(2);
    expect(bars.filter((bar) => bar.x2 === DEVELOPING_AXIS_X)).toHaveLength(1);
    expect(bars.filter((bar) => bar.x1 === -30)).toHaveLength(2);
    expect(bars.filter((bar) => bar.x2 === -30)).toHaveLength(1);
  });
});
