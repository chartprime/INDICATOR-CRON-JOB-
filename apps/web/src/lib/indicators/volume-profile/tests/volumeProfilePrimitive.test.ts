import { describe, expect, it, vi } from "vitest";
import {
  VolumeProfilePrimitive,
  DEFAULT_VOLUME_PROFILE_SETTINGS,
} from "../volumeProfilePrimitive";
import type { ProfileFrame } from "../../../../types/frames";

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
  const textCalls: Array<{ text: string; x: number; y: number; fill: string }> =
    [];
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
    strokeRect: (x: number, y: number, w: number, h: number) =>
      strokeRectCalls.push({ x, y, w, h }),
    setLineDash: (dash: number[]) => lineDashCalls.push(dash),
    fillText: (text: string, x: number, y: number) =>
      textCalls.push({ text, x, y, fill: context.fillStyle }),
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
      volume: 5,
      buy_volume: 3,
      sell_volume: 2,
      single_print: false,
    },
    {
      price: 102,
      volume: 20,
      buy_volume: 15,
      sell_volume: 5,
      single_print: false,
    },
    {
      price: 104,
      volume: 1,
      buy_volume: 1,
      sell_volume: 0,
      single_print: true,
    },
  ],
  poc_price: 102,
  vah_price: 102,
  val_price: 100,
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
  primitive: VolumeProfilePrimitive,
  timeScaleOverrides: Parameters<typeof fakeTimeScale>[0] = {},
) {
  const requestUpdate = vi.fn();
  primitive.attached({
    chart: { timeScale: () => fakeTimeScale(timeScaleOverrides) },
    series: { priceToCoordinate: (price: number) => price * 2 },
    requestUpdate,
  } as never);
  return requestUpdate;
}

/** Draws every pane view into one target and returns it. Bins reach the canvas
 * through whichever of the two bar views matches their onTop tag, so looking
 * at a single view would silently see nothing for one of the modes. */
function drawAllViews(primitive: VolumeProfilePrimitive) {
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

describe("VolumeProfilePrimitive", () => {
  it("renders one bar per bucket, widest at the POC, scaled by volume relative to the largest bucket", () => {
    const primitive = new VolumeProfilePrimitive();
    attach(primitive);
    primitive.setProfile(PROFILE);
    primitive.updateAllViews();

    expect(primitive.renderBars).toHaveLength(3);
    const [low, poc, high] = primitive.renderBars;
    expect(low.x1).toBe(10);
    expect(poc.x1).toBe(10);
    const lowWidth = low.x2 - low.x1;
    const pocWidth = poc.x2 - poc.x1;
    const highWidth = high.x2 - high.x1;
    expect(pocWidth).toBeCloseTo(
      DEFAULT_VOLUME_PROFILE_SETTINGS.maxBarWidthPx,
      5,
    );
    expect(lowWidth).toBeCloseTo(
      (5 / 20) * DEFAULT_VOLUME_PROFILE_SETTINGS.maxBarWidthPx,
      5,
    );
    expect(highWidth).toBeCloseTo(
      (1 / 20) * DEFAULT_VOLUME_PROFILE_SETTINGS.maxBarWidthPx,
      5,
    );
  });

  it("draws POC/VAH/VAL lines spanning from the period start to the chart's right edge while the period is still developing", () => {
    const primitive = new VolumeProfilePrimitive();
    attach(primitive);
    primitive.setProfile(PROFILE);
    primitive.updateAllViews();

    for (const line of primitive.renderLines) {
      expect(line.x1).toBe(10);
      expect(line.x2).toBe(800);
      expect(line.style).toBe("dashed");
    }
  });

  // Vertical placement had no assertions at all, which is why the profile drew
  // half a row low unnoticed since the indicator was written: bucket.price is
  // the band's LOWER edge, but the bins were drawn centred on it, and the level
  // lines -- plotted at the raw nominal prices -- then landed through the middle
  // of the bins they name.
  describe("bins sit on their true price bands, not centred on the band's lower edge", () => {
    it("covers [price, price + rowWidth] for every bucket", () => {
      const primitive = new VolumeProfilePrimitive();
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
      const primitive = new VolumeProfilePrimitive();
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
      const primitive = new VolumeProfilePrimitive();
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
      const primitive = new VolumeProfilePrimitive();
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
      const primitive = new VolumeProfilePrimitive();
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
      const primitive = new VolumeProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      const pocLabel = primitive.renderLabels.find((label) =>
        label.text.startsWith("POC"),
      )!;
      const pocLine = primitive.renderLines.find((line) => line.lineWidth > 1)!;
      expect(pocLabel.y).toBe(pocLine.y);
      expect(pocLabel.y).toBe((102 + ROW_WIDTH / 2) * 2);
    });

    it("keeps the value area's fill in step with its boundaries -- the tinted bins are exactly the ones between the two lines", () => {
      const primitive = new VolumeProfilePrimitive();
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
      const tintOf = (bin: (typeof primitive.renderBars)[number]) =>
        bin.totalFill.replace(/,[^,]*\)$/, ")");
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

      // PROFILE's value area is val 100 .. vah 102, i.e. buckets 100 and 102.
      expect(inside.map((bin) => spansOf(bin))).toEqual([
        { lo: 200, hi: 204 },
        { lo: 204, hi: 208 },
      ]);
      expect(outside).toHaveLength(1);
      expect(new Set(inside.map(tintOf)).size).toBe(1);
      expect(tintOf(inside[0])).not.toBe(tintOf(outside[0]));
    });
  });

  it("a closed period's lines span only to period_end_ts, and only the VAH/VAL pair stays dashed", () => {
    const primitive = new VolumeProfilePrimitive();
    attach(primitive);
    primitive.setProfile({ ...PROFILE, period_end_ts: 3000 });
    primitive.updateAllViews();

    expect(primitive.renderLines.length).toBeGreaterThan(0);
    for (const line of primitive.renderLines) {
      expect(line.x2).toBe(30);
    }
    // The POC line is solid once the period closes; VAH/VAL stay dashed at
    // every stage, which is what makes the value-area edge readable as an edge.
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
      const primitive = new VolumeProfilePrimitive();
      attach(primitive);
      primitive.setProfile({ ...PROFILE, period_end_ts: periodEnd });
      primitive.setSettings({
        ...DEFAULT_VOLUME_PROFILE_SETTINGS,
        showPocLine: false,
      });
      primitive.updateAllViews();

      expect(primitive.renderLines.length).toBe(2);
      for (const line of primitive.renderLines) {
        expect(line.lineWidth).toBe(1);
        expect(line.style).toBe("dashed");
      }

      // The dash array the renderer hands to the canvas, not just the flag --
      // and never the empty array that would draw them solid. The pattern is
      // applyLineStyle's own, the same one the delta views' lines use.
      const target = drawAllViews(primitive);
      expect(target.lineDashCalls).toEqual([
        [6, 4],
        [6, 4],
      ]);
    }
  });

  // Price labels are a developing-only affordance: they name the live levels
  // while the period is still forming, and every historical zone stays bare.
  describe("level labels on the developing profile", () => {
    it("labels the POC with its price and its volume, and both value-area edges with their prices", () => {
      const primitive = new VolumeProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      // PROFILE (developing, poc 102 volume 20, vah 102, val 100).
      const texts = primitive.renderLabels.map((label) => label.text);
      expect(texts).toContain("POC: 102.00 | 20");
      expect(texts).toContain("VAH: 102.00");
      expect(texts).toContain("VAL: 100.00");
    });

    // Regression guard. A developing period's lines end at the pane's right
    // edge, so anchoring labels to the right of that edge (left-aligned) put
    // them past the canvas, where the browser clipped them silently and no
    // label was ever visible on a real chart. Labels must stay inside the pane.
    it("keeps every label inside the pane's right edge, level with its own line", () => {
      const primitive = new VolumeProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      // The pane is 800px wide in the fake time scale.
      for (const label of primitive.renderLabels) {
        expect(label.x).toBeLessThan(800);
        expect(label.x).toBeGreaterThan(0);
      }
      const pocLabel = primitive.renderLabels.find((label) =>
        label.text.startsWith("POC"),
      )!;
      const pocLine = primitive.renderLines.find((line) => line.lineWidth > 1)!;
      expect(pocLabel.y).toBe(pocLine.y);
    });

    // The dashed level lines run straight through the band the text occupies, so
    // each label needs an opaque plate behind it or the dashes read through the
    // glyphs.
    it("draws an opaque plate behind each label, so the dashed line does not cross the text", () => {
      const primitive = new VolumeProfilePrimitive();
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
      const primitive = new VolumeProfilePrimitive();
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
      const primitive = new VolumeProfilePrimitive();
      attach(primitive);
      primitive.setProfile({ ...PROFILE, period_end_ts: 3000 });
      primitive.updateAllViews();

      expect(primitive.renderLines.length).toBeGreaterThan(0);
      expect(primitive.renderLabels).toEqual([]);
      expect(drawAllViews(primitive).textCalls).toEqual([]);
    });

    it("labels nothing for a historical zone, only the live one", () => {
      const primitive = new VolumeProfilePrimitive();
      attach(primitive);
      primitive.setHistoricalProfiles([
        { ...PROFILE, period_start_ts: 1000, period_end_ts: 3000 },
      ]);
      primitive.updateAllViews();

      expect(primitive.renderLabels).toEqual([]);
    });

    it("actually paints the labels through a pane view, not just records them", () => {
      const primitive = new VolumeProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      const target = drawAllViews(primitive);
      expect(target.textCalls.map((call) => call.text)).toEqual(
        primitive.renderLabels.map((label) => label.text),
      );
    });

    it("drops the POC label along with the POC line when the line is turned off", () => {
      const primitive = new VolumeProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.setSettings({
        ...DEFAULT_VOLUME_PROFILE_SETTINGS,
        showPocLine: false,
      });
      primitive.updateAllViews();

      expect(
        primitive.renderLabels.some((label) => label.text.startsWith("POC")),
      ).toBe(false);
      // The value-area labels are gated by their own setting, so they stay.
      expect(
        primitive.renderLabels.some((label) => label.text.startsWith("VAH")),
      ).toBe(true);
    });

    it("drops the value-area labels along with their lines", () => {
      const primitive = new VolumeProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.setSettings({
        ...DEFAULT_VOLUME_PROFILE_SETTINGS,
        showValueAreaLines: false,
      });
      primitive.updateAllViews();

      expect(primitive.renderLabels.map((label) => label.text)).toEqual([
        "POC: 102.00 | 20",
      ]);
    });

    // A collapsed value area draws one line, so it must draw one label -- not
    // two stacked on the same pixel.
    it("draws one value-area label where the area collapses to a single price", () => {
      const primitive = new VolumeProfilePrimitive();
      attach(primitive);
      primitive.setProfile({ ...PROFILE, vah_price: 102, val_price: 102 });
      primitive.updateAllViews();

      const valueAreaLabels = primitive.renderLabels.filter(
        (label) => label.text.startsWith("VAH") || label.text.startsWith("VAL"),
      );
      expect(valueAreaLabels).toHaveLength(1);
    });

    it("omits the POC volume when no bucket matches the POC price", () => {
      const primitive = new VolumeProfilePrimitive();
      attach(primitive);
      // A frame whose poc_price matches no bucket cannot arrive over the wire
      // (the parser rejects it), so this pins the defensive branch only.
      primitive.setProfile({ ...PROFILE, poc_price: 103 });
      primitive.updateAllViews();

      expect(primitive.renderLabels.map((label) => label.text)).toContain(
        "POC: 103.00",
      );
    });
  });

  // The restyle's central claim: every bin is a blue total box with the bin's
  // red sell box drawn inside it, on one shared price scale -- so the red
  // fraction reads as this bin's own sell share, and it can never overhang the
  // blue box it belongs to.
  describe("blue total box with the red sell box nested inside it", () => {
    it("scales the red box by sell_volume on the same scale as the blue box, not by its own max", () => {
      const primitive = new VolumeProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      const budget = DEFAULT_VOLUME_PROFILE_SETTINGS.maxBarWidthPx;
      const [low, poc] = primitive.renderBars;
      // bucket 100: volume 5, sell 2 -- both measured against the POC's 20.
      expect(low.x2 - low.x1).toBeCloseTo((5 / 20) * budget, 5);
      expect(low.sellX2 - low.x1).toBeCloseTo((2 / 20) * budget, 5);
      expect(poc.sellX2 - poc.x1).toBeCloseTo((5 / 20) * budget, 5);
    });

    it("anchors the red box at the bin's left edge and keeps it inside the blue box", () => {
      const primitive = new VolumeProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      for (const bin of primitive.renderBars) {
        expect(bin.sellX2).toBeGreaterThanOrEqual(bin.x1);
        expect(bin.sellX2).toBeLessThanOrEqual(bin.x2);
      }
    });

    it("leaves a bucket with no sell volume with a zero-width red box, so it draws blue only", () => {
      const primitive = new VolumeProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      const singlePrintBin = primitive.renderBars[2];
      expect(singlePrintBin.sellX2).toBe(singlePrintBin.x1);

      // Three live bins, two of which traded sell volume -> 5 fills, not 3.
      expect(drawAllViews(primitive).fillRectCalls).toHaveLength(5);
    });

    it("paints the red box after the blue one, inside its bounds", () => {
      const primitive = new VolumeProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      const [blue, red] = drawAllViews(primitive).fillRectCalls;
      expect(blue.x).toBe(primitive.renderBars[0].x1);
      expect(red.x).toBe(blue.x);
      expect(red.w).toBeLessThanOrEqual(blue.w);
    });

    it("gives the red box the same opacity as the blue box it sits on", () => {
      const primitive = new VolumeProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.updateAllViews();

      for (const bin of primitive.renderBars) {
        expect(alphaOf(bin.sellFill)).toBeCloseTo(alphaOf(bin.totalFill), 5);
      }

      // Still a gradient: a long bin's pair is more opaque than a short bin's.
      const [low, poc] = primitive.renderBars;
      expect(alphaOf(poc.sellFill)).toBeGreaterThan(alphaOf(low.sellFill));
    });

    // Value-area membership is a hue difference, not an alpha one. An earlier
    // default made the outside-value-area tint the value-area colour plus a
    // baked-in "7c" alpha, which collided with the bin gradient: at full
    // gradient strength the out-of-area bin faded back toward the in-area
    // colour, so the two regions converged instead of staying distinct.
    it("renders in-value-area and outside-value-area bins in visibly different colours at the same opacity", () => {
      const primitive = new VolumeProfilePrimitive();
      attach(primitive);
      // Three equal-volume buckets so the gradient, and therefore the alpha,
      // is identical across them -- only the hue may differ. val 100, vah 102
      // puts 98 and 104 outside the value area and 100 on its lower edge.
      primitive.setProfile({
        ...PROFILE,
        buckets: [
          {
            price: 98,
            volume: 10,
            buy_volume: 7,
            sell_volume: 3,
            single_print: false,
          },
          {
            price: 100,
            volume: 10,
            buy_volume: 7,
            sell_volume: 3,
            single_print: false,
          },
          {
            price: 104,
            volume: 10,
            buy_volume: 7,
            sell_volume: 3,
            single_print: false,
          },
        ],
        poc_price: 100,
        vah_price: 102,
        val_price: 100,
      });
      primitive.updateAllViews();

      const [belowVal, atVal, aboveVah] = primitive.renderBars;
      const rgbOf = (fill: string) => fill.replace(/,[^,]*\)$/, ")");

      expect(rgbOf(atVal.totalFill)).not.toBe(rgbOf(belowVal.totalFill));
      expect(rgbOf(belowVal.totalFill)).toBe(rgbOf(aboveVah.totalFill));
      // Equal volume, equal gradient: the distinction cannot be alpha.
      expect(alphaOf(atVal.totalFill)).toBeCloseTo(
        alphaOf(belowVal.totalFill),
        5,
      );
    });

    // The defaults carry no alpha of their own: both are 6-digit hex, so the
    // rendered alpha is exactly the bin gradient and the two tints cannot
    // drift into each other at the top of the gradient.
    it("ships two distinct, fully opaque default value-area tints", () => {
      const { valueAreaColor, outsideValueAreaColor } =
        DEFAULT_VOLUME_PROFILE_SETTINGS;
      expect(valueAreaColor).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(outsideValueAreaColor).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(valueAreaColor).not.toBe(outsideValueAreaColor);
    });
  });

  describe("bin opacity gradient follows bin length", () => {
    it("renders the longest bin at full opacity and every shorter bin fainter", () => {
      const primitive = new VolumeProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.setSettings({
        ...DEFAULT_VOLUME_PROFILE_SETTINGS,
        developingOpacity: 1,
      });
      primitive.updateAllViews();

      const [, poc, high] = primitive.renderBars;
      expect(alphaOf(poc.totalFill)).toBeCloseTo(1, 5);
      expect(alphaOf(high.totalFill)).toBeLessThan(alphaOf(poc.totalFill));
      // 15% opacity floor: the shortest bin stays visible instead of vanishing.
      expect(alphaOf(high.totalFill)).toBeGreaterThan(0);
    });

    it("rises monotonically with volume across the whole profile", () => {
      const primitive = new VolumeProfilePrimitive();
      attach(primitive);
      primitive.setProfile(PROFILE);
      primitive.setSettings({
        ...DEFAULT_VOLUME_PROFILE_SETTINGS,
        developingOpacity: 1,
      });
      primitive.updateAllViews();

      const [low, poc, high] = primitive.renderBars;
      expect(alphaOf(low.totalFill)).toBeGreaterThan(alphaOf(high.totalFill));
      expect(alphaOf(poc.totalFill)).toBeGreaterThan(alphaOf(low.totalFill));
    });

    it("does not tint the POC bin differently from an equal-volume non-POC bin -- the POC line marks it, not a fill", () => {
      const primitive = new VolumeProfilePrimitive();
      attach(primitive);
      // Two equal-volume buckets, only one of them the POC.
      primitive.setProfile({
        ...PROFILE,
        buckets: [
          {
            price: 100,
            volume: 20,
            buy_volume: 15,
            sell_volume: 5,
            single_print: false,
          },
          {
            price: 102,
            volume: 20,
            buy_volume: 15,
            sell_volume: 5,
            single_print: false,
          },
        ],
        poc_price: 102,
        vah_price: 102,
        val_price: 100,
      });
      primitive.updateAllViews();

      const [notPoc, poc] = primitive.renderBars;
      expect(poc.totalFill).toBe(notPoc.totalFill);
    });
  });

  it("draws no outline at all -- a single-print bucket is distinguished by nothing but its own blue/red boxes", () => {
    const primitive = new VolumeProfilePrimitive();
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
    expect(primitive.renderBars[2].totalFill).toBe(withSinglePrint.totalFill);
    expect(primitive.renderBars[2].sellFill).toBe(withSinglePrint.sellFill);
    expect(drawAllViews(primitive).strokeRectCalls).toHaveLength(0);
  });

  it("dims every fill and line color while developing, relative to a closed period at the same settings", () => {
    const developing = new VolumeProfilePrimitive();
    attach(developing);
    developing.setProfile(PROFILE);
    developing.updateAllViews();

    const closed = new VolumeProfilePrimitive();
    attach(closed);
    closed.setProfile({ ...PROFILE, period_end_ts: 3000 });
    closed.updateAllViews();

    expect(developing.renderBars[0].totalFill).not.toBe(
      closed.renderBars[0].totalFill,
    );
    expect(developing.renderBars[0].sellFill).not.toBe(
      closed.renderBars[0].sellFill,
    );
    expect(developing.renderLines[0].color).not.toBe(
      closed.renderLines[0].color,
    );
  });

  it("showPocLine and showValueAreaLines each independently gate their own lines", () => {
    const primitive = new VolumeProfilePrimitive();
    attach(primitive);
    primitive.setProfile(PROFILE);
    primitive.setSettings({
      ...DEFAULT_VOLUME_PROFILE_SETTINGS,
      showPocLine: false,
    });
    primitive.updateAllViews();
    expect(primitive.renderLines).toHaveLength(2);

    primitive.setSettings({
      ...DEFAULT_VOLUME_PROFILE_SETTINGS,
      showValueAreaLines: false,
    });
    primitive.updateAllViews();
    expect(primitive.renderLines).toHaveLength(1);
  });

  it("draws a single VAH/VAL line, not two overlapping ones, when the value area collapses to one price", () => {
    const primitive = new VolumeProfilePrimitive();
    attach(primitive);
    primitive.setProfile({ ...PROFILE, vah_price: 102, val_price: 102 });
    primitive.updateAllViews();

    const thinLines = primitive.renderLines.filter(
      (line) => line.lineWidth === 1,
    );
    expect(thinLines).toHaveLength(1);
  });

  it("clears stale render state when the profile is cleared or the primitive detaches", () => {
    const primitive = new VolumeProfilePrimitive();
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
    const primitive = new VolumeProfilePrimitive();
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
      const primitive = new VolumeProfilePrimitive();
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
      const primitive = new VolumeProfilePrimitive();
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
      const primitive = new VolumeProfilePrimitive();
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
      const primitive = new VolumeProfilePrimitive();
      attach(primitive);
      primitive.setHistoricalProfiles([ZONE_A]);
      primitive.updateAllViews();

      expect(primitive.renderBars.length).toBeGreaterThan(0);
      for (const line of primitive.renderLines) {
        expect(line.x1).toBe(10);
        expect(line.x2).toBe(30);
      }
    });

    it("always renders a historical zone's VAH/VAL dashed, while its POC line stays solid because the zone is closed by construction", () => {
      const primitive = new VolumeProfilePrimitive();
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
      const primitive = new VolumeProfilePrimitive();
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
      const primitive = new VolumeProfilePrimitive();
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
      const primitive = new VolumeProfilePrimitive();
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
      const primitive = new VolumeProfilePrimitive();
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
        DEFAULT_VOLUME_PROFILE_SETTINGS.maxBarWidthPx,
      );
    });

    it("still uses the full bar-width budget when the zone is wide enough to hold it", () => {
      const primitive = new VolumeProfilePrimitive();
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
        DEFAULT_VOLUME_PROFILE_SETTINGS.maxBarWidthPx,
        5,
      );
    });

    it("never collapses a very narrow zone's bars to nothing", () => {
      const primitive = new VolumeProfilePrimitive();
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
      const primitive = new VolumeProfilePrimitive();
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

  describe("bar layering -- Per-Candle profiles draw above the candles, others stay behind", () => {
    it("tags a Per-Candle profile's bars onTop, so they are not hidden behind an opaque candle body", () => {
      const primitive = new VolumeProfilePrimitive();
      attach(primitive);
      primitive.setProfile({ ...PROFILE, mode: "per_candle" });
      primitive.updateAllViews();

      expect(primitive.renderBars.length).toBeGreaterThan(0);
      for (const bar of primitive.renderBars) {
        expect(bar.onTop).toBe(true);
      }
    });

    it("leaves a Continuous profile's bars behind the candles, unchanged", () => {
      const primitive = new VolumeProfilePrimitive();
      attach(primitive);
      primitive.setProfile({ ...PROFILE, mode: "continuous" });
      primitive.updateAllViews();

      expect(primitive.renderBars.length).toBeGreaterThan(0);
      for (const bar of primitive.renderBars) {
        expect(bar.onTop).toBe(false);
      }
    });

    it("leaves a fixed_range profile's bars behind the candles too, matching Continuous", () => {
      const primitive = new VolumeProfilePrimitive();
      attach(primitive);
      primitive.setHistoricalProfiles([
        { ...PROFILE, mode: "fixed_range", period_end_ts: 3000 },
      ]);
      primitive.updateAllViews();

      expect(primitive.renderBars.length).toBeGreaterThan(0);
      for (const bar of primitive.renderBars) {
        expect(bar.onTop).toBe(false);
      }
    });

    it("tags each zone independently when Per-Candle and non-Per-Candle profiles render together", () => {
      const primitive = new VolumeProfilePrimitive();
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
      expect(historical.every((bar) => !bar.onTop)).toBe(true);
    });

    it("actually routes bars through the primitive's two zOrder pane views, not just tags them", () => {
      const primitive = new VolumeProfilePrimitive();
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

      const bottomBarCount = primitive.renderBars.filter(
        (bar) => !bar.onTop,
      ).length;
      const topBarCount = primitive.renderBars.filter(
        (bar) => bar.onTop,
      ).length;
      expect(bottomBarCount).toBeGreaterThan(0);
      expect(topBarCount).toBeGreaterThan(0);

      const drawnCounts = primitive.paneViews().map((view) => {
        const target = fakeCanvasTarget();
        view.renderer()?.draw?.(target as never);
        return {
          zOrder: view.zOrder?.(),
          fillRects: target.fillRectCalls.length,
          strokes: target.strokeCalls.length,
        };
      });

      // Each bin paints a blue total box and, when it traded any sell volume, a
      // red box inside it -- so the fill count is the bin count plus one per bin
      // that sold.
      const expectedFills = (bins: typeof primitive.renderBars) =>
        bins.length + bins.filter((bin) => bin.sellX2 > bin.x1).length;
      const bottomBins = primitive.renderBars.filter((bin) => !bin.onTop);
      const topBins = primitive.renderBars.filter((bin) => bin.onTop);

      const bottomView = drawnCounts.find((entry) => entry.zOrder === "bottom");
      expect(bottomView?.fillRects).toBe(expectedFills(bottomBins));

      const topBarViews = drawnCounts.filter(
        (entry) => entry.zOrder === "top" && entry.fillRects > 0,
      );
      expect(topBarViews).toHaveLength(1);
      expect(topBarViews[0].fillRects).toBe(expectedFills(topBins));

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
    const primitive = new VolumeProfilePrimitive();
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

describe("VolumeProfilePrimitive -- developing anchor pinned to the chart's left edge", () => {
  /** A time axis shifted 50px left, so the fixture's session start (x = 10 on
   * the default axis) lands at x = -40: off the pane, which is the state that
   * used to paint the whole developing profile at a negative x and lose it. */
  const OFF_SCREEN = { originPx: -50 };

  it("draws every bin from x = 0, each keeping its own width", () => {
    const primitive = new VolumeProfilePrimitive();
    attach(primitive, OFF_SCREEN);
    primitive.setProfile(PROFILE);
    primitive.updateAllViews();

    expect(primitive.renderBars).toHaveLength(3);
    for (const bin of primitive.renderBars) expect(bin.x1).toBe(0);

    // Only the anchor moved: the longest bin is still the full budget.
    const budget = DEFAULT_VOLUME_PROFILE_SETTINGS.maxBarWidthPx;
    expect(
      primitive.renderBars.some((bin) => bin.x2 - bin.x1 === budget),
    ).toBe(true);
  });

  it("runs the developing POC/VAH/VAL lines from the left edge to the chart's right edge", () => {
    const primitive = new VolumeProfilePrimitive();
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
    const primitive = new VolumeProfilePrimitive();
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
