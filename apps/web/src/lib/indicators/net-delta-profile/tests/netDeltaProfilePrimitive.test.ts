import { describe, expect, it, vi } from "vitest";
import {
  NetDeltaProfilePrimitive,
  DEFAULT_NET_DELTA_PROFILE_SETTINGS,
} from "../netDeltaProfilePrimitive";
import {
  BIN_VALUE_MAX_FONT_PX,
  BIN_VALUE_PAD_PX,
  DEFAULT_BIN_VALUE_BACKGROUND,
  MAX_LABELLED_HISTORICAL_PROFILES,
  binValueTextColor,
  fitBinValueFont,
} from "../../volume-profile/profileLevelLabels";
import type { ProfileFrame } from "../../../../types/frames";
import { withOpacity } from "../../volume-profile/profilePeriodGeometry";
import { OUTSIDE_VALUE_AREA_BIN_OPACITY } from "../../volume-profile/deltaProfileLevels";
import { DEFAULT_DELTA_PROFILE_SETTINGS } from "../../delta-profile/deltaProfilePrimitive";

/** The live chart's own panel colour and the dark historical one: the two
 * backgrounds a translucent bin's value ink has to work against. */
const LIVE_PANEL = DEFAULT_BIN_VALUE_BACKGROUND;
const HISTORICAL_PANEL = "#0c0c0c";

/** The fake chart's readback of `layout.background`, which the primitive uses
 * to composite a bin's translucent fill before choosing its value ink. */
function chartOptions(background: string) {
  return { layout: { background: { type: "solid", color: background } } };
}

// Mirrors lightweight-charts' own real behavior (verified directly against
// its source): exact-integer "seconds" are real bar timestamps and resolve
// via a strict match; anything else only resolves through timeToIndex's
// findNearest:true path, snapping to the nearest integer bar. This is the
// exact asymmetry the primitive's own timeToCoordinateNearest helper exists
// to bridge -- these fakes exist to prove that bridge actually works, not
// just to make the existing exact-timestamp fixtures pass.
function fakeCanvasTarget() {
  const fillRectCalls: Array<{ x: number; y: number; w: number; h: number }> =
    [];
  const strokeRectCalls: Array<{ x: number; y: number; w: number; h: number }> =
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
  const fontCalls: string[] = [];
  const saveStack: Array<Record<string, unknown>> = [];
  const STYLE_KEYS = [
    "fillStyle",
    "strokeStyle",
    "lineWidth",
    "font",
    "textAlign",
    "textBaseline",
  ] as const;
  let fontValue = "";
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
    get font() {
      return fontValue;
    },
    set font(value: string) {
      fontValue = value;
      fontCalls.push(value);
    },
    textAlign: "",
    textBaseline: "",
    fillRect: (x: number, y: number, w: number, h: number) =>
      fillRectCalls.push({ x, y, w, h }),
    strokeRect: (x: number, y: number, w: number, h: number) =>
      strokeRectCalls.push({ x, y, w, h }),
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
    strokeRectCalls,
    strokeCalls,
    lineDashCalls,
    textCalls,
    plateCalls,
    fillCalls,
    fontCalls,
    context,
    saveStack,
    useMediaCoordinateSpace: (
      callback: (scope: { context: typeof context }) => void,
    ) => callback({ context }),
  };
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

// Delta fixture. Per-bucket net delta (buy - sell) drives everything now:
//   100 -> +10, 102 -> +20 (POC), 104 -> -3.
// |delta| weights 10/20/3 total 33; at 70% the target is 23.1; the POC's 20
// pulls in the heavier neighbour below (10 > above's 3), so the delta value
// area is buckets 100..102, leaving 104 outside it. Two net-buy bins, one
// net-sell bin.
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
      volume: 18,
      buy_volume: 14,
      sell_volume: 4,
      single_print: false,
    },
    {
      price: 102,
      volume: 28,
      buy_volume: 24,
      sell_volume: 4,
      single_print: false,
    },
    {
      price: 104,
      volume: 9,
      buy_volume: 3,
      sell_volume: 6,
      single_print: false,
    },
  ],
  // The frame's own levels describe total volume and are now ignored by the
  // renderer, which derives delta levels from the buckets instead.
  poc_price: 102,
  vah_price: 102,
  val_price: 100,
};

/** A fixture engineered so exactly one bucket carries the whole delta value
 * area: its |delta| alone clears the 70% target, collapsing VAH and VAL onto
 * one price. Its first bucket is deliberately balanced, so it also proves a
 * zero-delta bucket draws no bin. */
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

/** The fixture profile's row width: how tall one price band is, in price. */
const ROW_WIDTH = 2;

/** True when a bin occupies exactly the price band [price, price + rowWidth].
 *
 * A bucket's price is the band's LOWER edge -- the server buckets by
 * floor((price - originPrice) / rowWidth) -- so a bin must cover that band.
 * Asserting the pair of edges rather than a single literal keeps the check
 * independent of which way the price axis points (yTop is the smaller pixel
 * value either way). Centring a bin on its price puts one edge half a row out
 * and fails this, which is the "bins drawn half a row low" bug. */
function occupiesBand(
  bin: { yTop: number; yBottom: number },
  price: number,
  rowWidth: number,
): boolean {
  return (
    bin.yTop === Math.min(price, price + rowWidth) * 2 &&
    bin.yBottom === Math.max(price, price + rowWidth) * 2
  );
}

function attach(
  primitive: NetDeltaProfilePrimitive,
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

/** Draws every pane view into one target and returns it. Bins reach the canvas
 * through whichever of the two bar views matches their onTop tag, so looking
 * at a single view would silently see nothing for one of the modes. */
function drawAllViews(primitive: NetDeltaProfilePrimitive) {
  const target = fakeCanvasTarget();
  for (const view of primitive.paneViews()) {
    view.renderer()?.draw?.(target as never);
  }
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

/** Prefix of the rgba string `withOpacity` builds from a 6-digit hex -- the
 * channel values (no spaces, matching withOpacity's own formatting), ready to
 * compare a fill's hue against a settings colour. */
function rgbPrefixOfHex(hex: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},`;
}

describe("NetDeltaProfilePrimitive", () => {
  it("renders one signed bin per nonzero-delta bucket, widest at the delta POC, scaled by |delta| against the largest |delta|", () => {
    const primitive = new NetDeltaProfilePrimitive();
    attach(primitive);
    primitive.setProfile(PROFILE);
    primitive.updateAllViews();

    expect(primitive.renderBars).toHaveLength(3);
    const [low, poc, sell] = primitive.renderBars;
    const budget = DEFAULT_NET_DELTA_PROFILE_SETTINGS.maxBarWidthPx;
    // Every bin grows right from the zone's left edge.
    expect(low.x1).toBe(10);
    expect(poc.x1).toBe(10);
    expect(sell.x1).toBe(10);
    expect(poc.x2 - poc.x1).toBeCloseTo(budget, 5);
    expect(low.x2 - low.x1).toBeCloseTo((10 / 20) * budget, 5);
    // The sell bin's length is its |delta| (3), never its sell volume (6).
    expect(sell.x2 - sell.x1).toBeCloseTo((3 / 20) * budget, 5);
  });

  it("signs the bins -- a net-buy bucket takes the buy tint, a net-sell bucket the sell tint", () => {
    const primitive = new NetDeltaProfilePrimitive();
    attach(primitive);
    primitive.setProfile(PROFILE);
    primitive.updateAllViews();

    const [buyInVa, buyInVa2, sell] = primitive.renderBars;
    // 100 and 102 are net-buy and inside the delta value area; 104 is net-sell
    // and outside it, so it takes the plain sell colour.
    expect(rgbOf(buyInVa.fill)).toBe(rgbOf(buyInVa2.fill));
    expect(rgbOf(sell.fill)).not.toBe(rgbOf(buyInVa.fill));
    expect(
      sell.fill.startsWith(
        rgbPrefixOfHex(DEFAULT_NET_DELTA_PROFILE_SETTINGS.sellColor),
      ),
    ).toBe(true);
  });

  it("draws nothing for a bucket whose buy and sell volumes net to zero", () => {
    const primitive = new NetDeltaProfilePrimitive();
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

    // The balanced bucket contributes no bin at all -- not a zero-width one.
    expect(primitive.renderBars).toHaveLength(3);
    expect(
      primitive.renderBars.some((bar) => occupiesBand(bar, 106, ROW_WIDTH)),
    ).toBe(false);
  });

  it("draws POC/VAH/VAL lines spanning from the period start to the chart's right edge while the period is still developing", () => {
    const primitive = new NetDeltaProfilePrimitive();
    attach(primitive);
    primitive.setProfile(PROFILE);
    primitive.updateAllViews();

    for (const line of primitive.renderLines) {
      expect(line.x1).toBe(10);
      expect(line.x2).toBe(800);
    }
    // Developing: the POC is dashed, and the VAH/VAL pair take the default
    // dashed style.
    const pocLine = primitive.renderLines.find((line) => line.lineWidth > 1);
    expect(pocLine?.style).toBe("dashed");
    expect(
      primitive.renderLines
        .filter((line) => line.lineWidth === 1)
        .every((line) => line.style === "dashed"),
    ).toBe(true);
  });

  // Vertical placement had no assertions at all, which is why the profile drew
  // half a row low unnoticed since the indicator was written: bucket.price is
  // the band's LOWER edge, but the bins were drawn centred on it, and the level
  // lines -- plotted at the raw nominal prices -- then landed through the middle
  // of the bins they name.
  describe("bins sit on their true price bands, not centred on the band's lower edge", () => {
    it("covers [price, price + rowWidth] for every bucket", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      // PROFILE: prices 100, 102, 104 with row_width 2 via priceToCoordinate
      // (price) => price * 2.
      expect(primitive.renderBars).toHaveLength(3);
      for (const [index, bin] of primitive.renderBars.entries()) {
        const price = PROFILE.buckets[index].price;
        expect({ price, band: occupiesBand(bin, price, ROW_WIDTH) }).toEqual({
          price,
          band: true,
        });
      }
    });

    it("stacks adjacent bins with no overlap and no gap, rather than overlapping by half a row", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      const [low, next] = primitive.renderBars;
      // 100 and 102 are one row apart and each spans a full row, so the two
      // pixel intervals must meet at exactly one shared boundary. Centring them
      // on their nominal prices would overlap them by half a row instead.
      const [loLo, loHi] = [low.yTop, low.yBottom].sort((a, b) => a - b);
      const [nxLo, nxHi] = [next.yTop, next.yBottom].sort((a, b) => a - b);
      const shared = [loLo, loHi].filter((y) => y === nxLo || y === nxHi);
      expect(shared).toEqual([204]);
    });

    it("puts the highest bin's far edge one full row above its nominal price, not half a row", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      const high = primitive.renderBars[2];
      // price 104, row_width 2 -> the band's far edge is 106 (pixel 212). The
      // old centred reading put it at 105 (pixel 210).
      expect([high.yTop, high.yBottom].sort((a, b) => a - b)).toEqual([
        208, 212,
      ]);
    });

    it("draws VAL along the value area's lower boundary and VAH along its upper boundary, one row above vah_price", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      // PROFILE: val 100 (lower edge of the lowest in-VA bucket, so already the
      // area's floor), vah 102 (lower edge of the highest in-VA bucket, so the
      // area's ceiling is 104).
      const valLine = primitive.renderLines.find((line) => line.y === 100 * 2);
      const vahLine = primitive.renderLines.find(
        (line) => line.y === (102 + ROW_WIDTH) * 2,
      );
      expect(valLine).toBeDefined();
      expect(vahLine).toBeDefined();

      // Each line must sit on an edge of the bin it bounds -- never inside it,
      // which is where the old half-row offset put it.
      const boundsOf = (price: number) => {
        const bin = primitive.renderBars.find((bar) =>
          occupiesBand(bar, price, ROW_WIDTH),
        )!;
        return [bin.yTop, bin.yBottom];
      };
      const valBinBounds = boundsOf(100);
      const vahBinBounds = boundsOf(102);
      expect(valBinBounds).toContain(valLine!.y);
      expect(vahBinBounds).toContain(vahLine!.y);
      for (const bounds of [valBinBounds, vahBinBounds]) {
        const midpoint = (bounds[0] + bounds[1]) / 2;
        expect(bounds).not.toContain(midpoint);
      }
    });

    // The deliberate counterpart to the bin fix: the POC is a LEVEL, not a
    // boundary, so -- unlike VAH/VAL -- it stays in the middle of the bin it
    // names. Moving the bins onto their true bands while leaving the POC at the
    // raw nominal price had quietly pushed it down to the bin's lower edge.
    it("draws the POC line through the middle of its bin, one half row above poc_price", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      // PROFILE: poc_price 102, row_width 2 -> bin spans [102, 104] in price,
      // so the level is at 103 (pixel 206).
      const pocLine = primitive.renderLines.find((line) => line.lineWidth > 1)!;
      expect(pocLine.y).toBe((102 + ROW_WIDTH / 2) * 2);

      const pocBin = primitive.renderBars.find((bar) =>
        occupiesBand(bar, 102, ROW_WIDTH),
      )!;
      const bounds = [pocBin.yTop, pocBin.yBottom].sort((a, b) => a - b);
      expect(pocLine.y).toBe((bounds[0] + bounds[1]) / 2);
      // And explicitly not on either edge, which is what the POC regression was.
      expect(bounds).not.toContain(pocLine.y);
    });

    it("keeps the POC label level with the POC line, so the text names the line it sits on", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      const pocLabel = primitive.renderLabels.find((label) =>
        label.text.startsWith("Δ POC"),
      )!;
      const pocLine = primitive.renderLines.find((line) => line.lineWidth > 1)!;
      expect(pocLabel.y).toBe(pocLine.y);
      expect(pocLabel.y).toBe((102 + ROW_WIDTH / 2) * 2);
    });

    it("keeps the value area's fill in step with its boundaries -- the tinted bins are exactly the ones between the two lines", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      const valLine = primitive.renderLines.find((line) => line.y === 100 * 2)!;
      const vahLine = primitive.renderLines.find(
        (line) => line.y === (102 + ROW_WIDTH) * 2,
      )!;
      // The two boundaries as a pixel interval, independent of axis direction.
      const lower = Math.min(valLine.y, vahLine.y);
      const upper = Math.max(valLine.y, vahLine.y);

      // Value-area membership is a hue difference, so every in-VA bin shares one
      // fill and it differs from the out-of-VA fill.
      const spansOf = (bin: (typeof primitive.renderBars)[number]) => ({
        lo: Math.min(bin.yTop, bin.yBottom),
        hi: Math.max(bin.yTop, bin.yBottom),
      });
      const inside = primitive.renderBars.filter(
        (bin) => spansOf(bin).lo >= lower && spansOf(bin).hi <= upper,
      );
      const outside = primitive.renderBars.filter(
        (bin) => !(spansOf(bin).lo >= lower && spansOf(bin).hi <= upper),
      );

      // The delta value area is buckets 100 and 102.
      expect(inside.map((bin) => spansOf(bin))).toEqual([
        { lo: 200, hi: 204 },
        { lo: 204, hi: 208 },
      ]);
      expect(outside).toHaveLength(1);
      expect(new Set(inside.map((bin) => rgbOf(bin.fill))).size).toBe(1);
      expect(rgbOf(inside[0].fill)).not.toBe(rgbOf(outside[0].fill));
    });
  });

  it("a closed period's lines span only to period_end_ts, and the POC solidifies while VAH/VAL keep their own style", () => {
    const primitive = new NetDeltaProfilePrimitive();
    attach(primitive);
    primitive.setProfile({ ...PROFILE, period_end_ts: 3000 });
    primitive.updateAllViews();

    expect(primitive.renderLines.length).toBeGreaterThan(0);
    for (const line of primitive.renderLines) {
      expect(line.x2).toBe(30);
    }
    // The POC line is solid once the period closes; VAH/VAL keep the style the
    // user chose (dashed by default) at every stage, which is what makes the
    // value-area edge readable as an edge.
    const pocLine = primitive.renderLines.find((line) => line.lineWidth > 1);
    expect(pocLine?.style).toBe("solid");
    expect(
      primitive.renderLines
        .filter((line) => line.lineWidth === 1)
        .every((line) => line.style === "dashed"),
    ).toBe(true);
  });

  it("draws every VAH/VAL line dashed and one pixel wide, developing or closed", () => {
    for (const periodEnd of [null, 3000]) {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile({ ...PROFILE, period_end_ts: periodEnd });
      primitive.setSettings({
        ...DEFAULT_NET_DELTA_PROFILE_SETTINGS,
        showPocLine: false,
      });
      primitive.updateAllViews();

      expect(primitive.renderLines.length).toBe(2);
      for (const line of primitive.renderLines) {
        expect(line.lineWidth).toBe(1);
        expect(line.style).toBe("dashed");
      }

      // The dash array the renderer hands to the canvas, not just the style
      // field -- and never the empty array that would draw them solid.
      const target = drawAllViews(primitive);
      expect(target.lineDashCalls).toEqual([
        [6, 4],
        [6, 4],
      ]);
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
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.setSettings({
        ...DEFAULT_NET_DELTA_PROFILE_SETTINGS,
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

  // Price labels are a developing-only affordance: they name the live levels
  // while the period is still forming, and every historical zone stays bare.
  describe("level labels on the developing profile", () => {
    it("labels the delta POC with its price and its signed net delta, and both value-area edges with their prices", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      // Delta POC bucket 102, net delta +20; delta value area 100..102. The
      // levels are delta-derived, so each is prefixed with "Δ" -- a bare
      // "POC" on this terminal means the most-traded volume price.
      const texts = primitive.renderLabels.map((label) => label.text);
      expect(texts).toContain("Δ POC: 102.00 | +20");
      expect(texts).toContain("Δ VAH: 102.00");
      expect(texts).toContain("Δ VAL: 100.00");
    });

    it("signs the POC delta, so a net-sell POC reads negative rather than as a bare magnitude", () => {
      const primitive = new NetDeltaProfilePrimitive();
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

    // Regression guard. A developing period's lines end at the pane's right
    // edge, so anchoring labels to the right of that edge (left-aligned) put
    // them past the canvas, where the browser clipped them silently and no
    // label was ever visible on a real chart. Labels must stay inside the pane.
    it("keeps every label inside the pane's right edge, level with its own line", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      // The pane is 800px wide in the fake time scale.
      for (const label of primitive.renderLabels) {
        expect(label.x).toBeLessThan(800);
        expect(label.x).toBeGreaterThan(0);
      }
      const pocLabel = primitive.renderLabels.find((label) =>
        label.text.startsWith("Δ POC"),
      )!;
      const pocLine = primitive.renderLines.find((line) => line.lineWidth > 1)!;
      expect(pocLabel.y).toBe(pocLine.y);
    });

    // The dashed level lines run straight through the band the text occupies, so
    // each label needs an opaque plate behind it or the dashes read through the
    // glyphs.
    it("draws an opaque plate behind each label, so the dashed line does not cross the text", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      const target = drawAllViews(primitive);
      const labelCount = primitive.renderLabels.length;
      expect(labelCount).toBeGreaterThan(0);

      // One plate per label, and the plate is what gets filled -- never the
      // label colour, which is drawn as text only. The fill must be opaque
      // white: any transparency would let the dashes read through the label.
      expect(target.plateCalls).toHaveLength(labelCount);
      expect(target.fillCalls).toHaveLength(labelCount);
      for (const fill of target.fillCalls) {
        expect(fill).toBe("#ffffff");
      }
    });

    it("hugs the plate to the measured text, centred, and keeps it inside the pane", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      const target = drawAllViews(primitive);
      // The fake measureText is 6px per character, plus 5px padding each side.
      for (const [index, label] of primitive.renderLabels.entries()) {
        const plate = target.plateCalls[index];
        const textWidth = label.text.length * 6;
        expect(plate.w).toBeCloseTo(textWidth + 10, 5);
        // Equal padding either side of the text: the text is right-aligned at
        // label.x, so it spans [label.x - textWidth, label.x] and the plate
        // adds PAD_X_PX beyond that on both sides.
        expect(plate.x).toBeCloseTo(label.x - textWidth - 5, 5);
        expect(plate.x + plate.w).toBeCloseTo(label.x + 5, 5);
        // The whole plate must stay within the 800px pane or it gets clipped.
        expect(plate.x).toBeGreaterThanOrEqual(0);
        expect(plate.x + plate.w).toBeLessThan(800);
      }
    });

    it("labels nothing once the period closes", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile({ ...PROFILE, period_end_ts: 3000 });
      primitive.updateAllViews();

      expect(primitive.renderLines.length).toBeGreaterThan(0);
      expect(primitive.renderLabels).toEqual([]);
      expect(drawAllViews(primitive).textCalls).toEqual([]);
    });

    it("labels nothing for a historical zone, only the live one", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setHistoricalProfiles([
        { ...PROFILE, period_start_ts: 1000, period_end_ts: 3000 },
      ]);
      primitive.updateAllViews();

      expect(primitive.renderLabels).toEqual([]);
    });

    it("actually paints the labels through a pane view, not just records them", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      const target = drawAllViews(primitive);
      expect(target.textCalls.map((call) => call.text)).toEqual(
        primitive.renderLabels.map((label) => label.text),
      );
    });

    it("drops the POC label along with the POC line when the line is turned off", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.setSettings({
        ...DEFAULT_NET_DELTA_PROFILE_SETTINGS,
        showPocLine: false,
      });
      primitive.updateAllViews();

      expect(
        primitive.renderLabels.some((label) => label.text.startsWith("Δ POC")),
      ).toBe(false);
      // The value-area labels are gated by their own setting, so they stay.
      expect(
        primitive.renderLabels.some((label) => label.text.startsWith("Δ VAH")),
      ).toBe(true);
    });

    it("drops the value-area labels along with their lines", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.setSettings({
        ...DEFAULT_NET_DELTA_PROFILE_SETTINGS,
        showValueAreaLines: false,
      });
      primitive.updateAllViews();

      expect(primitive.renderLabels.map((label) => label.text)).toEqual([
        "Δ POC: 102.00 | +20",
      ]);
    });

    // A collapsed value area draws one line, so it must draw one label -- not
    // two stacked on the same pixel.
    it("draws one value-area label where the area collapses to a single price", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(COLLAPSED_VA_PROFILE);
      primitive.updateAllViews();

      const valueAreaLabels = primitive.renderLabels.filter(
        (label) =>
          label.text.startsWith("Δ VAH") || label.text.startsWith("Δ VAL"),
      );
      expect(valueAreaLabels).toHaveLength(1);
    });
  });

  // A delta profile bin is one signed bar: net buying extends right in the buy
  // colour, net selling in the sell colour, both from the zone's left edge, and
  // the length is the bin's own |delta| against the profile's largest |delta|.
  describe("signed net-delta bins", () => {
    it("scales each bin by |delta| against the profile's max |delta|, not by its own side's max", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      const budget = DEFAULT_NET_DELTA_PROFILE_SETTINGS.maxBarWidthPx;
      const [low, poc, sell] = primitive.renderBars;
      // 100 -> +10, 102 -> +20 (POC), 104 -> -3.
      expect(low.x2 - low.x1).toBeCloseTo((10 / 20) * budget, 5);
      expect(poc.x2 - poc.x1).toBeCloseTo((20 / 20) * budget, 5);
      // The sell bin's length is its |delta| (3), never its sell volume (6).
      expect(sell.x2 - sell.x1).toBeCloseTo((3 / 20) * budget, 5);
    });

    it("grows every bin rightward from the zone's start line, so nothing overhangs it", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      for (const bin of primitive.renderBars) {
        expect(bin.x1).toBe(10);
        expect(bin.x2).toBeGreaterThan(bin.x1);
      }
    });

    it("uses the sell hue for a net-sell bin and the buy hue for a net-buy one", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      const [low, poc, sell] = primitive.renderBars;
      // 100 and 102 are net-buy and inside the value area; 104 is net-sell and
      // outside it, so it takes the plain sell colour.
      expect(rgbOf(low.fill)).toBe(rgbOf(poc.fill));
      expect(
        sell.fill.startsWith(
          rgbPrefixOfHex(DEFAULT_NET_DELTA_PROFILE_SETTINGS.sellColor),
        ),
      ).toBe(true);
      expect(rgbOf(sell.fill)).not.toBe(rgbOf(low.fill));
      // One signed fill per bin -- three bins, three fills.
      expect(drawAllViews(primitive).fillRectCalls).toHaveLength(3);
    });

    // Value-area membership is now BOTH a hue and an opacity difference: an
    // in-value-area bin takes the vivid tint at the bright band's alpha, an
    // outside bin the dim tint at the shallow band's alpha. Direction must
    // still read as a hue, never as the value area flipping sign.
    it("draws in-value-area bins in the vivid band and outside bins dimmer, both still on the sign's hue", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      // Three equal-|delta| buy buckets. |delta| 10/20/10, total 40, target 28:
      // the POC (102) plus its equal-weight neighbour above (104) make the value
      // area, leaving 100 outside it.
      primitive.setProfile({
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
      });
      primitive.updateAllViews();

      const [outside, poc, inVa] = primitive.renderBars;
      // Same |delta| (10), so the only opacity difference is the band itself:
      // the value-area bin is brighter than the one outside the area.
      expect(alphaOf(inVa.fill)).toBeGreaterThan(alphaOf(outside.fill));
      // Both stay on the buy hue -- value-area membership is not a sign flip.
      expect(rgbOf(inVa.fill)).not.toBe(rgbOf(outside.fill));
      expect(rgbOf(poc.fill)).toBe(rgbOf(inVa.fill));
    });

    it("grades opacity WITHIN each band, so neither the value area nor its surround goes flat", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      // 100 (+5, outside), 102 (+20, POC/inside), 104 (+10, inside).
      primitive.setProfile({
        ...PROFILE,
        buckets: [
          {
            price: 100,
            volume: 5,
            buy_volume: 5,
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
      });
      primitive.setSettings({
        ...DEFAULT_NET_DELTA_PROFILE_SETTINGS,
        developingOpacity: 1,
      });
      primitive.updateAllViews();

      const [outside, poc, inVa] = primitive.renderBars;
      // The heaviest bin tops the vivid band; the lighter in-area bin is fainter
      // but still above every outside-bin alpha, so the bands never overlap.
      expect(alphaOf(poc.fill)).toBeCloseTo(1, 5);
      expect(alphaOf(inVa.fill)).toBeLessThan(alphaOf(poc.fill));
      expect(alphaOf(inVa.fill)).toBeGreaterThan(alphaOf(outside.fill));
    });

    // All four tints carry no alpha of their own: each is 6-digit hex, so the
    // rendered alpha is exactly the bin gradient and no two tints can drift
    // into each other at the top of the gradient.
    it("ships four distinct, fully opaque buy/sell value-area tints", () => {
      const { buyColor, buyValueAreaColor, sellColor, sellValueAreaColor } =
        DEFAULT_NET_DELTA_PROFILE_SETTINGS;
      for (const color of [
        buyColor,
        buyValueAreaColor,
        sellColor,
        sellValueAreaColor,
      ]) {
        expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
      expect(buyColor).not.toBe(buyValueAreaColor);
      expect(sellColor).not.toBe(sellValueAreaColor);
    });
  });

  // Each bin prints its own signed net delta inside its box, left-aligned to
  // the bar's own start edge and sized so the box can actually hold it --
  // hidden rather than overflowing when too small.
  describe("bin value text", () => {
    /** A tall, wide price axis, so every fixture bin is large enough to hold a
     * value -- the default fixture's 4px bands cannot. */
    function attachRoomy(
      primitive: NetDeltaProfilePrimitive,
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

    it("prints each bin's signed delta left-aligned to the bar's start edge", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attachRoomy(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      const binValues = drawAllViews(primitive).textCalls.filter((call) =>
        /^[+-][\d,]+$/.test(call.text),
      );
      // PROFILE deltas: 100 -> +10, 102 -> +20, 104 -> -3.
      expect(binValues.map((call) => call.text)).toEqual(["+10", "+20", "-3"]);
      for (const [index, bin] of primitive.renderBars.entries()) {
        expect(binValues[index].align).toBe("left");
        // Anchored just inside the bar's own x1, vertically centred.
        expect(binValues[index].x).toBeCloseTo(bin.x1 + 2, 5);
        expect(binValues[index].y).toBeCloseTo((bin.yTop + bin.yBottom) / 2, 5);
      }
    });

    it("prints no per-bin values once closed session zones exceed the legible count", () => {
      const primitive = new NetDeltaProfilePrimitive();
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
      const primitive = new NetDeltaProfilePrimitive();
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
      const primitive = new NetDeltaProfilePrimitive();
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
      expect(binValues.map((call) => call.text)).toEqual(["+10", "+20", "-3"]);
    });

    it("keeps per-bin values on a few closed session zones", () => {
      const primitive = new NetDeltaProfilePrimitive();
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
      expect(binValues.map((call) => call.text)).toEqual(["+10", "+20", "-3"]);
    });

    it("still prints per-bin values for a fixed-range zone", () => {
      const primitive = new NetDeltaProfilePrimitive();
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
      expect(binValues.map((call) => call.text)).toEqual(["+10", "+20", "-3"]);
    });

    it("skips a bin too small to hold its value, drawing no overflowing text", () => {
      const primitive = new NetDeltaProfilePrimitive();
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

    // The fitting rule itself, exercised directly: it is the part that must
    // scale with the box and refuse to overflow.
    describe("fitBinValueFont", () => {
      // A plausible canvas: 0.6em per character.
      const measure = (text: string, size: number) => text.length * size * 0.6;

      it("grows as the box gets taller, up to the cap", () => {
        const short = fitBinValueFont(measure, "+20", 80, 12)!;
        const tall = fitBinValueFont(measure, "+20", 80, 40)!;
        expect(tall).toBeGreaterThan(short);
        expect(tall).toBe(BIN_VALUE_MAX_FONT_PX);
      });

      it("shrinks to the box's width when the text is long, never overflowing", () => {
        const size = fitBinValueFont(measure, "+1,234,567", 60, 40)!;
        expect(size).toBeLessThan(BIN_VALUE_MAX_FONT_PX);
        expect(measure("+1,234,567", size)).toBeLessThanOrEqual(
          60 - 2 * BIN_VALUE_PAD_PX + 1e-6,
        );
      });

      it("returns null when the box cannot hold a legible label", () => {
        expect(fitBinValueFont(measure, "+20", 80, 4)).toBeNull();
        expect(fitBinValueFont(measure, "+20", 6, 40)).toBeNull();
      });
    });

    it("picks a contrasting text colour from the bin composited over the chart", () => {
      // Bright teal is a light fill -> near-black text; red is dark -> white.
      expect(binValueTextColor("rgba(63,208,208,0.9)", LIVE_PANEL)).toBe(
        "#0a0a0a",
      );
      expect(binValueTextColor("rgba(220,38,38,1)", LIVE_PANEL)).toBe(
        "#ffffff",
      );
    });

    it("inks an outside-value-area bin at the minimum alpha for the panel it is drawn on", () => {
      // The faintest outside-value-area bin: the sell colour at the band's own
      // minimum, times the profile's developing opacity. That composite is
      // pale over the live chart's near-white panel, so it needs dark ink --
      // judging the raw fill picked white and measured about 1.6:1. Over the
      // dark historical panel the same bin stays dark, so white ink is right.
      const faintSell = withOpacity(
        DEFAULT_NET_DELTA_PROFILE_SETTINGS.sellColor,
        OUTSIDE_VALUE_AREA_BIN_OPACITY.min *
          DEFAULT_NET_DELTA_PROFILE_SETTINGS.developingOpacity,
      );
      expect(binValueTextColor(faintSell, LIVE_PANEL)).toBe("#0a0a0a");
      expect(binValueTextColor(faintSell, HISTORICAL_PANEL)).toBe("#ffffff");
    });

    it("always picks the ink with the higher WCAG contrast, for every delta profile fill, alpha and panel", () => {
      const rgb = (hex: string) =>
        [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
      const linear = (value: number) => {
        const scaled = value / 255;
        return scaled <= 0.03928
          ? scaled / 12.92
          : ((scaled + 0.055) / 1.055) ** 2.4;
      };
      const luminance = ([r, g, b]: number[]) =>
        0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
      const contrast = (a: number[], b: number[]) => {
        const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (high + 0.05) / (low + 0.05);
      };
      const fills = [
        DEFAULT_NET_DELTA_PROFILE_SETTINGS.buyColor,
        DEFAULT_NET_DELTA_PROFILE_SETTINGS.buyValueAreaColor,
        DEFAULT_NET_DELTA_PROFILE_SETTINGS.sellColor,
        DEFAULT_NET_DELTA_PROFILE_SETTINGS.sellValueAreaColor,
        DEFAULT_DELTA_PROFILE_SETTINGS.buyColor,
        DEFAULT_DELTA_PROFILE_SETTINGS.buyValueAreaColor,
        DEFAULT_DELTA_PROFILE_SETTINGS.sellColor,
        DEFAULT_DELTA_PROFILE_SETTINGS.sellValueAreaColor,
      ];
      let worst = Infinity;
      for (const panel of [LIVE_PANEL, HISTORICAL_PANEL]) {
        for (const fill of fills) {
          for (let step = 20; step <= 100; step += 1) {
            const alpha = step / 100;
            const seen = rgb(fill).map(
              (channel, index) =>
                channel * alpha + rgb(panel)[index] * (1 - alpha),
            );
            const ink = binValueTextColor(withOpacity(fill, alpha), panel);
            const other = ink === "#ffffff" ? "#0a0a0a" : "#ffffff";
            const chosen = contrast(rgb(ink), seen);
            expect(chosen).toBeGreaterThanOrEqual(contrast(rgb(other), seen));
            worst = Math.min(worst, chosen);
          }
        }
      }
      expect(worst).toBeGreaterThan(4.4);
    });

    it("falls back to the live panel colour when the chart background is unreadable", () => {
      expect(binValueTextColor("rgba(30,111,224,0.245)")).toBe(
        binValueTextColor("rgba(30,111,224,0.245)", LIVE_PANEL),
      );
    });

    it("reads the panel colour from the chart's own layout background", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive, {}, HISTORICAL_PANEL);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      expect(primitive.valueBackground).toBe(HISTORICAL_PANEL);
    });

    it("inks every drawn value against the chart's own panel, not the raw fill", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attachRoomy(primitive, HISTORICAL_PANEL);
      primitive.setProfile(PROFILE);
      primitive.setSettings({
        ...DEFAULT_NET_DELTA_PROFILE_SETTINGS,
        developingOpacity: 1,
      });
      primitive.updateAllViews();

      const values = drawAllViews(primitive).textCalls.filter((call) =>
        /^[+-][\d,]+$/.test(call.text),
      );
      expect(values.map((call) => call.fill)).toEqual(
        primitive.renderBars.map((bar) =>
          binValueTextColor(bar.fill, HISTORICAL_PANEL),
        ),
      );
      // The composite is what makes the difference: judging the raw fills, as
      // the pre-fix code did, inks at least one of these the other way.
      expect(values.map((call) => call.fill)).not.toEqual(
        primitive.renderBars.map((bar) => binValueTextColor(bar.fill)),
      );
    });
  });

  describe("bin opacity gradient follows bin length", () => {
    it("renders the longest bin at full opacity and every shorter bin fainter", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.setSettings({
        ...DEFAULT_NET_DELTA_PROFILE_SETTINGS,
        developingOpacity: 1,
      });
      primitive.updateAllViews();

      const [, poc, sell] = primitive.renderBars;
      expect(alphaOf(poc.fill)).toBeCloseTo(1, 5);
      expect(alphaOf(sell.fill)).toBeLessThan(alphaOf(poc.fill));
      // The gradient has a floor: the shortest bin stays visible, not vanished.
      expect(alphaOf(sell.fill)).toBeGreaterThan(0);
    });

    it("rises monotonically with |delta| across the whole profile", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.setSettings({
        ...DEFAULT_NET_DELTA_PROFILE_SETTINGS,
        developingOpacity: 1,
      });
      primitive.updateAllViews();

      const [low, poc, sell] = primitive.renderBars;
      expect(alphaOf(sell.fill)).toBeLessThan(alphaOf(low.fill));
      expect(alphaOf(low.fill)).toBeLessThan(alphaOf(poc.fill));
    });

    it("does not tint the POC bin differently from an equal-|delta| non-POC bin -- the POC line marks it, not a fill", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      // Two equal-|delta| buckets, both inside the value area, only one the POC.
      primitive.setProfile({
        ...PROFILE,
        buckets: [
          {
            price: 100,
            volume: 20,
            buy_volume: 20,
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
        ],
      });
      primitive.updateAllViews();

      const [notPoc, poc] = primitive.renderBars;
      expect(poc.fill).toBe(notPoc.fill);
    });
  });

  describe("value-area percent setting", () => {
    // Three buy buckets whose |delta| weights are 5 / 20 / 10 (total 35), with
    // the POC in the middle. The target share decides how far the area expands
    // outward from that POC: 70% (24.5) reaches the +10 neighbour above, while
    // 20% (7) is already met by the POC's own 20.
    const WIDENING_PROFILE = {
      ...PROFILE,
      buckets: [
        {
          price: 100,
          volume: 5,
          buy_volume: 5,
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

    it("defaults to 70%, matching the server's own volume-based convention", () => {
      expect(DEFAULT_NET_DELTA_PROFILE_SETTINGS.valueAreaPercent).toBe(0.7);
    });

    it("grows the delta value area as the percent rises -- the VAH moves up to pull in the next bucket", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);

      // 20% is satisfied by the POC bucket alone, so VAH and VAL both sit on it.
      primitive.setProfile(WIDENING_PROFILE);
      primitive.setSettings({
        ...DEFAULT_NET_DELTA_PROFILE_SETTINGS,
        valueAreaPercent: 0.2,
      });
      primitive.updateAllViews();
      expect(
        primitive.renderLines.filter((l) => l.lineWidth === 1),
      ).toHaveLength(1);

      // 70% (24.5 of 35) must reach the heavier neighbour above (|delta| 10),
      // so the area spans buckets 102..104, and the VAH line appears a row
      // above the top bucket (104 + rowWidth). At 20% it was absent -- the
      // value area had collapsed onto the POC alone.
      primitive.setSettings({
        ...DEFAULT_NET_DELTA_PROFILE_SETTINGS,
        valueAreaPercent: 0.7,
      });
      primitive.updateAllViews();
      const thinLines = primitive.renderLines.filter((l) => l.lineWidth === 1);
      expect(thinLines).toHaveLength(2);
      expect(thinLines.some((l) => l.y === (104 + ROW_WIDTH) * 2)).toBe(true);
    });

    it("repaints in/out tint membership from the chosen percent, not a hardcoded 70%", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(WIDENING_PROFILE);

      // At 70% the +10 bucket (104) is inside the value area, so it draws in the
      // bright in-VA tint and outranks the shallow outside band's ceiling.
      primitive.setSettings({
        ...DEFAULT_NET_DELTA_PROFILE_SETTINGS,
        valueAreaPercent: 0.7,
        developingOpacity: 1,
      });
      primitive.updateAllViews();
      const atSeventy = primitive.renderBars.map((bar) => alphaOf(bar.fill));

      // At 20% only the POC counts, so 104 falls outside the value area and its
      // alpha drops from the vivid band into the dim one.
      primitive.setSettings({
        ...DEFAULT_NET_DELTA_PROFILE_SETTINGS,
        valueAreaPercent: 0.2,
        developingOpacity: 1,
      });
      primitive.updateAllViews();
      const atTwenty = primitive.renderBars.map((bar) => alphaOf(bar.fill));

      expect(atSeventy[2]).toBeGreaterThan(atTwenty[2]);
    });
  });

  it("draws no outline at all -- a single-print bucket is distinguished by nothing but its own signed bin", () => {
    const primitive = new NetDeltaProfilePrimitive();
    attach(primitive);
    primitive.setProfile(PROFILE);
    primitive.updateAllViews();

    const withSinglePrint = primitive.renderBars[2];
    expect(drawAllViews(primitive).strokeRectCalls).toHaveLength(0);

    // Flipping the one bucket's single_print flag changes nothing about how it
    // renders: no fill accent, no outline, no tint of its own.
    primitive.setProfile({
      ...PROFILE,
      buckets: PROFILE.buckets.map((bucket, index) =>
        index === 2 ? { ...bucket, single_print: false } : bucket,
      ),
    });
    primitive.updateAllViews();
    expect(primitive.renderBars[2].fill).toBe(withSinglePrint.fill);
    expect(drawAllViews(primitive).strokeRectCalls).toHaveLength(0);
  });

  it("dims every fill and line color while developing, relative to a closed period at the same settings", () => {
    const developing = new NetDeltaProfilePrimitive();
    attach(developing);
    developing.setProfile(PROFILE);
    developing.updateAllViews();

    const closed = new NetDeltaProfilePrimitive();
    attach(closed);
    closed.setProfile({ ...PROFILE, period_end_ts: 3000 });
    closed.updateAllViews();

    expect(developing.renderBars[0].fill).not.toBe(closed.renderBars[0].fill);
    expect(developing.renderLines[0].color).not.toBe(
      closed.renderLines[0].color,
    );
  });

  it("showPocLine and showValueAreaLines each independently gate their own lines", () => {
    const primitive = new NetDeltaProfilePrimitive();
    attach(primitive);
    primitive.setProfile(PROFILE);
    primitive.setSettings({
      ...DEFAULT_NET_DELTA_PROFILE_SETTINGS,
      showPocLine: false,
    });
    primitive.updateAllViews();
    expect(primitive.renderLines).toHaveLength(2);

    primitive.setSettings({
      ...DEFAULT_NET_DELTA_PROFILE_SETTINGS,
      showValueAreaLines: false,
    });
    primitive.updateAllViews();
    expect(primitive.renderLines).toHaveLength(1);
  });

  it("draws a single VAH/VAL line, not two overlapping ones, when the value area collapses to one price", () => {
    const primitive = new NetDeltaProfilePrimitive();
    attach(primitive);
    primitive.setProfile(COLLAPSED_VA_PROFILE);
    primitive.updateAllViews();

    const thinLines = primitive.renderLines.filter(
      (line) => line.lineWidth === 1,
    );
    expect(thinLines).toHaveLength(1);
  });

  it("clears stale render state when the profile is cleared or the primitive detaches", () => {
    const primitive = new NetDeltaProfilePrimitive();
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
    const primitive = new NetDeltaProfilePrimitive();
    attach(primitive, { hasPoints: false });
    primitive.setProfile(PROFILE);
    primitive.updateAllViews();
    expect(primitive.renderBars).toEqual([]);
    expect(primitive.renderLines).toEqual([]);
  });

  // Closure-audit regression, caught live: a real profile drawn on a real
  // running chart rendered nothing at all, in every mode. lightweight-charts'
  // own timeToCoordinate does a strict, exact match against the series' own
  // bar timestamps (findNearest hardcoded false in its own source, verified
  // directly) -- it never interpolates. period_start_ts/period_end_ts are
  // arbitrary server wall-clock milliseconds; they essentially never land
  // exactly on a bar boundary, so timeToCoordinate returned null on nearly
  // every real frame and wiped the whole render every time.
  describe("resolves an off-grid period timestamp instead of rendering nothing (the live bug)", () => {
    it("renders bars and lines for a period_start_ts that does not land on an exact bar boundary", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      // 1300ms -> 1.3s: not an integer, would have failed the old exact-match
      // timeToCoordinate the instant it was tried against a live chart.
      primitive.setProfile({ ...PROFILE, period_start_ts: 1300 });
      primitive.updateAllViews();

      expect(primitive.renderBars.length).toBeGreaterThan(0);
      expect(primitive.renderLines.length).toBeGreaterThan(0);
      // snaps to the nearest real bar (Math.round(1.3) = 1), matching what
      // the exact-integer fixture already resolves to.
      expect(primitive.renderBars[0].x1).toBe(10);
    });

    it("snaps a closed period's off-grid end time to the nearest bar too, not just the start", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile({
        ...PROFILE,
        period_start_ts: 1000,
        period_end_ts: 2600,
      });
      primitive.updateAllViews();

      const pocLine = primitive.renderLines.find((line) => line.lineWidth > 1);
      expect(pocLine).toBeDefined();
      // Math.round(2.6) = 3 -> logicalToCoordinate(3) = 30, not null/width().
      expect(pocLine?.x2).toBe(30);
    });

    it("a completely empty chart (no bars loaded yet) still fails closed to nothing, not a wrong guess", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive, { hasPoints: false });
      primitive.setProfile({ ...PROFILE, period_start_ts: 1300 });
      primitive.updateAllViews();
      expect(primitive.renderBars).toEqual([]);
      expect(primitive.renderLines).toEqual([]);
    });
  });

  // ATAS-style historical rendering: every visible closed period gets its
  // own shaded zone, confined to its own span, layered alongside the live
  // one -- no toggle, this is the indicator's default behavior.
  describe("setHistoricalProfiles -- multi-zone historical rendering", () => {
    const ZONE_A: ProfileFrame = {
      ...PROFILE,
      period_start_ts: 1000,
      period_end_ts: 3000,
    };
    const ZONE_B: ProfileFrame = {
      ...PROFILE,
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
    };

    it("confines a historical zone's lines to its own [x1, x2], never falling back to the chart's right edge", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setHistoricalProfiles([ZONE_A]);
      primitive.updateAllViews();

      expect(primitive.renderBars.length).toBeGreaterThan(0);
      for (const line of primitive.renderLines) {
        expect(line.x1).toBe(10);
        expect(line.x2).toBe(30);
      }
    });

    it("always renders a historical zone's VAH/VAL in the chosen style, while its POC line stays solid because the zone is closed by construction", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setHistoricalProfiles([ZONE_A]);
      primitive.updateAllViews();

      expect(
        primitive.renderLines
          .filter((line) => line.lineWidth === 1)
          .every((line) => line.style === "dashed"),
      ).toBe(true);
      const pocLine = primitive.renderLines.find((line) => line.lineWidth > 1);
      expect(pocLine?.style).toBe("solid");
    });

    // As in the Delta Profile equivalent: the bottom/top partition is computed at
    // update time, not on every paint. Renderer calls happen per frame, so
    // partitioning once keeps dense historical profiles allocation-free on the
    // paint path without changing the visual layering these tests pin.
    it("renders every historical zone independently, each keeping its own bars' x-position", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setHistoricalProfiles([ZONE_A, ZONE_B]);
      primitive.updateAllViews();

      const zoneABars = primitive.renderBars.filter((bar) => bar.x1 === 10);
      const zoneBBars = primitive.renderBars.filter((bar) => bar.x1 === 40);
      expect(zoneABars.length).toBeGreaterThan(0);
      expect(zoneBBars.length).toBeGreaterThan(0);
      expect(zoneABars.length + zoneBBars.length).toBe(
        primitive.renderBars.length,
      );
    });

    it("layers the live profile on top of historical zones -- both render together, neither replacing the other", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.setHistoricalProfiles([ZONE_B]);
      primitive.updateAllViews();

      const liveBars = primitive.renderBars.filter((bar) => bar.x1 === 10);
      const historicalBars = primitive.renderBars.filter(
        (bar) => bar.x1 === 40,
      );
      expect(liveBars.length).toBeGreaterThan(0);
      expect(historicalBars.length).toBeGreaterThan(0);
    });

    it("a historical zone with no resolvable end time renders nothing for that zone, rather than extending to the chart's full width", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setHistoricalProfiles([{ ...ZONE_A, period_end_ts: null }]);
      primitive.updateAllViews();

      expect(primitive.renderBars).toEqual([]);
      expect(primitive.renderLines).toEqual([]);
    });

    // Per-Candle mode makes every candle its own zone. A fixed 110px bar cap
    // meant each candle's bars reached across ~9 neighbours at normal chart
    // density, smearing the whole indicator into an unreadable wash.
    it("keeps a narrow zone's bars inside that zone instead of smearing across its neighbours", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      // period 1000ms -> 2000ms maps to x 10 -> 20, a 10px-wide zone.
      primitive.setHistoricalProfiles([
        { ...ZONE_A, period_start_ts: 1000, period_end_ts: 2000 },
      ]);
      primitive.updateAllViews();

      const widest = Math.max(
        ...primitive.renderBars.map((bar) => bar.x2 - bar.x1),
      );
      expect(widest).toBeLessThanOrEqual(10);
      expect(widest).toBeLessThan(
        DEFAULT_NET_DELTA_PROFILE_SETTINGS.maxBarWidthPx,
      );
    });

    it("still uses the full bar-width budget when the zone is wide enough to hold it", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      // 1000 -> 21000 maps to x 10 -> 210: a 200px zone, wider than the cap.
      primitive.setHistoricalProfiles([
        { ...ZONE_A, period_start_ts: 1000, period_end_ts: 21000 },
      ]);
      primitive.updateAllViews();

      const widest = Math.max(
        ...primitive.renderBars.map((bar) => bar.x2 - bar.x1),
      );
      expect(widest).toBeCloseTo(
        DEFAULT_NET_DELTA_PROFILE_SETTINGS.maxBarWidthPx,
        5,
      );
    });

    it("never collapses a very narrow zone's bars to nothing", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setHistoricalProfiles([
        { ...ZONE_A, period_start_ts: 1000, period_end_ts: 1100 },
      ]);
      primitive.updateAllViews();

      for (const bar of primitive.renderBars) {
        expect(bar.x2 - bar.x1).toBeGreaterThan(0);
      }
    });

    it("clears historical zones independently of the live profile", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.setHistoricalProfiles([ZONE_A]);
      primitive.updateAllViews();
      expect(primitive.renderBars.length).toBeGreaterThan(3);

      primitive.setHistoricalProfiles([]);
      primitive.updateAllViews();
      const remaining = primitive.renderBars.filter((bar) => bar.x1 === 10);
      expect(remaining).toHaveLength(3);
    });
  });

  describe("bar layering -- every profile draws above the candles", () => {
    it("registers the lines BEFORE the on-top bars, so bins paint above POC/VAH/VAL", () => {
      const primitive = new NetDeltaProfilePrimitive();
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
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile({ ...PROFILE, mode: "per_candle" });
      primitive.updateAllViews();

      expect(primitive.renderBars.length).toBeGreaterThan(0);
      for (const bar of primitive.renderBars) {
        expect(bar.onTop).toBe(true);
      }
    });

    it("tags a Continuous profile's bars onTop too, so the overlay is not tied to the mode", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setProfile({ ...PROFILE, mode: "continuous" });
      primitive.updateAllViews();

      expect(primitive.renderBars.length).toBeGreaterThan(0);
      for (const bar of primitive.renderBars) {
        expect(bar.onTop).toBe(true);
      }
    });

    it("tags a fixed_range profile's bars onTop, matching Continuous", () => {
      const primitive = new NetDeltaProfilePrimitive();
      attach(primitive);
      primitive.setHistoricalProfiles([
        { ...PROFILE, mode: "fixed_range", period_end_ts: 3000 },
      ]);
      primitive.updateAllViews();

      expect(primitive.renderBars.length).toBeGreaterThan(0);
      for (const bar of primitive.renderBars) {
        expect(bar.onTop).toBe(true);
      }
    });

    it("tags every zone onTop when Per-Candle and non-Per-Candle profiles render together", () => {
      const primitive = new NetDeltaProfilePrimitive();
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
        },
      ]);
      primitive.updateAllViews();

      const live = primitive.renderBars.filter((bar) => bar.x1 === 10);
      const historical = primitive.renderBars.filter((bar) => bar.x1 === 40);
      expect(live.length).toBeGreaterThan(0);
      expect(historical.length).toBeGreaterThan(0);
      expect(live.every((bar) => bar.onTop)).toBe(true);
      expect(historical.every((bar) => bar.onTop)).toBe(true);
    });

    it("actually routes every bar through the top zOrder pane view, not just tags them", () => {
      const primitive = new NetDeltaProfilePrimitive();
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

      // Every bin is onTop now, so the bottom bar view paints nothing and the
      // top bar view carries them all.
      const bottomView = drawnCounts.find((entry) => entry.zOrder === "bottom");
      expect(bottomView?.fillRects).toBe(0);

      const topBarViews = drawnCounts.filter(
        (entry) => entry.zOrder === "top" && entry.fillRects > 0,
      );
      expect(topBarViews).toHaveLength(1);
      expect(topBarViews[0].fillRects).toBe(barCount);

      const lineView = drawnCounts.find((entry) => entry.strokes > 0);
      expect(lineView?.fillRects).toBe(0);
    });
  });

  // L1L2-V2-087. Every pane primitive draws onto the same shared 2D context,
  // in attach order. One that assigns fillStyle/strokeStyle/lineWidth and
  // returns without restoring leaves them set for whatever draws next, so an
  // indicator's appearance depends on which other indicators happen to be
  // enabled -- the cross-indicator coupling Phase 18 existed to remove. The
  // two hand-written setLineDash([]) resets this replaced were the same fix
  // applied by hand to one property at a time.
  it("leaves the shared canvas context exactly as it found it, on every pane view", () => {
    const primitive = new NetDeltaProfilePrimitive();
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

describe("NetDeltaProfilePrimitive -- developing anchor pinned to the chart's left edge", () => {
  /** A time axis shifted 50px left, so the fixture's session start (x = 10 on
   * the default axis) lands at x = -40: off the pane, which is the state that
   * used to paint the whole developing profile at a negative x and lose it. */
  const OFF_SCREEN = { originPx: -50 };

  it("draws every bin from x = 0, each keeping its own width", () => {
    const primitive = new NetDeltaProfilePrimitive();
    attach(primitive, OFF_SCREEN);
    primitive.setProfile(PROFILE);
    primitive.updateAllViews();

    // PROFILE deltas are +10 / +20 / -3, so all three buckets draw.
    expect(primitive.renderBars).toHaveLength(3);
    for (const bin of primitive.renderBars) expect(bin.x1).toBe(0);

    // Only the anchor moved: the longest bin is still the full budget.
    const budget = DEFAULT_NET_DELTA_PROFILE_SETTINGS.maxBarWidthPx;
    expect(
      primitive.renderBars.some((bin) => bin.x2 - bin.x1 === budget),
    ).toBe(true);
  });

  it("runs the developing delta POC/VAH/VAL lines from the left edge to the chart's right edge", () => {
    const primitive = new NetDeltaProfilePrimitive();
    attach(primitive, OFF_SCREEN);
    primitive.setProfile(PROFILE);
    primitive.updateAllViews();

    expect(primitive.renderLines.length).toBeGreaterThan(0);
    for (const line of primitive.renderLines) {
      expect(line.x1).toBe(0);
      expect(line.x2).toBe(800);
    }
  });

  it("leaves a historical zone at its true off-screen x in the same pass", () => {
    const primitive = new NetDeltaProfilePrimitive();
    attach(primitive, OFF_SCREEN);
    primitive.setProfile(PROFILE);
    primitive.setHistoricalProfiles([
      { ...PROFILE, period_start_ts: 1500, period_end_ts: 2500 },
    ]);
    primitive.updateAllViews();

    // 1500 snaps to bar 2 -> -30, unclamped; the developing period sits at 0.
    const anchors = [...new Set(primitive.renderBars.map((bin) => bin.x1))].sort(
      (a, b) => a - b,
    );
    expect(anchors).toEqual([-30, 0]);
  });
});
