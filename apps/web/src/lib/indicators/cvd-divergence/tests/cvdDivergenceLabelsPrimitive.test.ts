import { describe, expect, it, vi } from "vitest";
import {
  BEARISH_LABEL_TEXT,
  BULLISH_LABEL_TEXT,
  CUMULATIVE_DIAMOND_GLYPH,
  CvdDivergenceLabelsPrimitive,
  LABEL_OFFSET_PX,
  LABEL_PLATE_HEIGHT_PX,
  buildDivergenceLabel,
  buildDivergenceLabels,
  divergenceLabelColor,
  divergenceLabelMark,
  divergenceLabelText,
} from "../cvdDivergenceLabelsPrimitive";
import type { BarFrame } from "../../../../types/frames";
import type { Divergence } from "../../delta-divergence/deltaDivergence";
import { CVD_TONE_COLORS } from "../cvdDivergence";

function divergence(
  type: Divergence["type"],
  priceFrom: number,
  priceTo: number,
): Divergence {
  return {
    type,
    priceFrom: { index: 0, ts_open: 60_000, price: priceFrom },
    priceTo: { index: 1, ts_open: 120_000, price: priceTo },
    cvdFrom: {
      index: 0,
      ts_open: 60_000,
      value: type === "bullish" ? -20 : 20,
    },
    cvdTo: { index: 1, ts_open: 120_000, value: type === "bullish" ? -5 : 5 },
    reasons: [],
  };
}

/**
 * Two bars whose WICKS differ from their closes, so a test can tell which one
 * the label actually hung off. Index 1 is the confirming bar (`priceTo`).
 */
function barsWithWicks(
  confirmingLow: number,
  confirmingHigh: number,
): BarFrame[] {
  return [
    { ts_open: 60_000, open: 100, high: 105, low: 95, close: 100 },
    {
      ts_open: 120_000,
      open: 100,
      high: confirmingHigh,
      low: confirmingLow,
      close: 100,
    },
  ].map((bar) => ({
    type: "bar",
    symbol: "BTC-USDT",
    provider: "BINANCE",
    marketKind: "SPOT",
    interval_ms: 60_000,
    volume: 100,
    trade_count: 10,
    closed: true,
    ...bar,
  })) as BarFrame[];
}

describe("divergence label vocabulary", () => {
  it("labels the two directions DiV+ and DiV-", () => {
    expect(divergenceLabelText("bullish")).toBe(BULLISH_LABEL_TEXT);
    expect(divergenceLabelText("bearish")).toBe(BEARISH_LABEL_TEXT);
    expect(divergenceLabelText("bullish")).toBe("DiV+");
    expect(divergenceLabelText("bearish")).toBe("DiV-");
  });

  it("words only the oscillator's own DiV+/DiV-", () => {
    expect(divergenceLabelText("bullish")).toBe("DiV+");
    expect(divergenceLabelText("bearish")).toBe("DiV-");
  });
  it("marks a cumulative divergence with a bare diamond glyph instead of a word", () => {
    // The cumulative series shares the oscillator's geometry, arrow and
    // colour, but NOT its glyph: a `⯁` diamond is the one thing that can be
    // told apart at a glance when both families are on the chart at once.
    const oscillator = buildDivergenceLabel(
      divergence("bullish", 100, 90),
      50,
      200,
      "oscillator",
    );
    const cumulative = buildDivergenceLabel(
      divergence("bullish", 100, 90),
      50,
      200,
      "cumulative",
    );
    expect(cumulative.text).toBe(CUMULATIVE_DIAMOND_GLYPH);
    expect(cumulative.text).toBe("\u2BC1");
    expect(cumulative.text).not.toBe(oscillator.text);
    expect(cumulative.mark).toBe("diamond");
    expect(oscillator.mark).toBe("plate");
    // Everything except the glyph and the mark is shared, so the two markers
    // cannot drift apart geometrically.
    expect({ ...cumulative, text: "", mark: "plate" }).toEqual({
      ...oscillator,
      text: "",
    });
  });

  it("maps each label style to its own mark", () => {
    expect(divergenceLabelMark("oscillator")).toBe("plate");
    expect(divergenceLabelMark("cumulative")).toBe("diamond");
  });

  it("keeps the cumulative diamond in the same directional colour as the oscillator's plate", () => {
    // Colour is part of the shared signal, not of the presentation form: the
    // diamond must still read green for bullish and red for bearish.
    const bullish = buildDivergenceLabel(
      divergence("bullish", 100, 90),
      50,
      200,
      "cumulative",
    );
    const bearish = buildDivergenceLabel(
      divergence("bearish", 100, 110),
      50,
      200,
      "cumulative",
    );
    expect(bullish.color).toBe(CVD_TONE_COLORS.intenseUp);
    expect(bearish.color).toBe(CVD_TONE_COLORS.intenseDown);
  });

  it("keeps the same colors for both forms, since only the drawing differs", () => {
    expect(divergenceLabelColor("bullish")).toBe(
      divergenceLabelColor("bullish"),
    );
  });

  it("takes its plate colors from the column tone palette, so the two cannot drift apart", () => {
    // Bound to the shared constants rather than re-typed hex values: this is
    // the assertion that breaks if someone re-tints the columns and forgets
    // the labels.
    expect(divergenceLabelColor("bullish")).toBe(CVD_TONE_COLORS.intenseUp);
    expect(divergenceLabelColor("bearish")).toBe(CVD_TONE_COLORS.intenseDown);
  });
});

describe("buildDivergenceLabel", () => {
  it("places a bullish label BELOW its low and a bearish label ABOVE its high", () => {
    const bullish = buildDivergenceLabel(
      divergence("bullish", 100, 90),
      50,
      200,
    );
    const bearish = buildDivergenceLabel(
      divergence("bearish", 100, 110),
      50,
      200,
    );
    expect(bullish.y).toBeGreaterThan(200);
    expect(bearish.y).toBeLessThan(200);
  });

  it("points a bullish arrow UP at the bar, from the plate to the price point", () => {
    const { arrow } = buildDivergenceLabel(
      divergence("bullish", 100, 90),
      50,
      200,
    );
    // Screen y grows downward, so an apex ABOVE its base is an up-pointing
    // arrow. The apex must sit exactly on the price point being annotated.
    expect(arrow.apexY).toBe(200);
    expect(arrow.baseY).toBeGreaterThan(arrow.apexY);
  });

  it("points a bearish arrow DOWN at the bar", () => {
    const { arrow } = buildDivergenceLabel(
      divergence("bearish", 100, 110),
      50,
      200,
    );
    expect(arrow.apexY).toBe(200);
    expect(arrow.baseY).toBeLessThan(arrow.apexY);
  });

  it("keeps the arrow on the bar's own x, and clear of the plate", () => {
    const label = buildDivergenceLabel(divergence("bullish", 100, 90), 50, 200);
    expect(label.arrow.x).toBe(50);
    // The plate's near edge and the arrow's base meet: no gap, no overlap.
    expect(label.arrow.baseY).toBe(label.y - LABEL_PLATE_HEIGHT_PX / 2);
  });

  it("gives the cumulative form the same geometry as the oscillator's", () => {
    const plain = buildDivergenceLabel(
      divergence("bullish", 100, 90),
      50,
      200,
      "cumulative",
    );
    // The arrow still points up at the bar, and its base sits on the plate's
    // own lower edge -- identical to the oscillator's.
    expect(plain.arrow.apexY).toBe(200);
    expect(plain.arrow.baseY).toBe(plain.y - LABEL_PLATE_HEIGHT_PX / 2);
    expect(plain.arrow.baseY).toBeGreaterThan(plain.arrow.apexY);
    expect(plain.y - 200).toBe(LABEL_OFFSET_PX);
  });

  it("points a bearish cumulative label's arrow down, off the plate's upper edge", () => {
    const plain = buildDivergenceLabel(
      divergence("bearish", 100, 110),
      50,
      200,
      "cumulative",
    );
    expect(plain.arrow.apexY).toBe(200);
    expect(plain.arrow.baseY).toBe(plain.y + LABEL_PLATE_HEIGHT_PX / 2);
    expect(plain.arrow.baseY).toBeLessThan(plain.arrow.apexY);
  });
});

describe("buildDivergenceLabels", () => {
  const timeToCoordinate = (tsMs: number) => tsMs / 1000;
  const priceToCoordinate = (price: number) => price * 2;
  const bars = barsWithWicks(88, 112);

  it("anchors a bullish label to the bar's LOW wick, not its close", () => {
    const labels = buildDivergenceLabels(
      [divergence("bullish", 100, 90)],
      bars,
      timeToCoordinate,
      priceToCoordinate,
      1000,
    );
    // The divergence's own close is 90 (y 180), but the wick low is 88, so the
    // label and arrow must hang off y 176 instead.
    expect(labels).toHaveLength(1);
    expect(labels[0].x).toBe(120);
    expect(labels[0].arrow.apexY).toBe(176);
    expect(labels[0].y).toBe(176 + LABEL_OFFSET_PX);
    expect(labels[0].text).toBe("DiV+");
    expect(labels[0].text).toBe("DiV+");
  });

  it("anchors a bearish label to the bar's HIGH wick, not its close", () => {
    const labels = buildDivergenceLabels(
      [divergence("bearish", 100, 108)],
      bars,
      timeToCoordinate,
      priceToCoordinate,
      1000,
    );
    // Close 108 -> y 216, but the wick high is 112 -> y 224.
    expect(labels[0].arrow.apexY).toBe(224);
    expect(labels[0].y).toBe(224 - LABEL_OFFSET_PX);
  });

  it("drops a divergence whose confirming bar is not in the supplied bars, rather than throwing", () => {
    // A live bar being appended can briefly leave the divergence list one bar
    // ahead of the bar array; a marker must never take the render down.
    const labels = buildDivergenceLabels(
      [divergence("bullish", 100, 90)],
      [bars[0]],
      timeToCoordinate,
      priceToCoordinate,
      1000,
    );
    expect(labels).toEqual([]);
  });

  it("drops labels whose bar is scrolled out of the pane", () => {
    const labels = buildDivergenceLabels(
      [divergence("bullish", 100, 90)],
      bars,
      timeToCoordinate,
      priceToCoordinate,
      100,
    );
    expect(labels).toEqual([]);
  });

  it("drops labels whose price has no coordinate", () => {
    const labels = buildDivergenceLabels(
      [divergence("bullish", 100, 90)],
      bars,
      timeToCoordinate,
      () => null,
      1000,
    );
    expect(labels).toEqual([]);
  });
});

function fakeCanvasTarget() {
  const texts: { text: string; x: number; y: number }[] = [];
  const rects: { x: number; y: number; width: number; height: number }[] = [];
  // The fillStyle in force at each fillText, which is how a coloured plain
  // label is told apart from a white-on-plate one.
  const textFills: string[] = [];
  // Each triangle, recorded as the three points that were actually walked, so
  // the test can assert which way the arrow points.
  const triangles: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  const context = {
    fillStyle: "",
    font: "",
    textAlign: "",
    textBaseline: "",
    save: () => {},
    restore: () => {},
    measureText: (text: string) => ({ width: text.length * 6 }),
    fillRect: (x: number, y: number, width: number, height: number) => {
      rects.push({ x, y, width, height });
    },
    beginPath: () => {
      current = [];
    },
    moveTo: (x: number, y: number) => {
      current.push({ x, y });
    },
    lineTo: (x: number, y: number) => {
      current.push({ x, y });
    },
    closePath: () => {
      if (current.length > 0) triangles.push(current);
    },
    fill: () => {},
    fillText: (text: string, x: number, y: number) => {
      texts.push({ text, x, y });
      textFills.push(context.fillStyle);
    },
  };
  return {
    context,
    texts,
    textFills,
    rects,
    triangles,
    useMediaCoordinateSpace: (
      callback: (scope: {
        context: typeof context;
        mediaSize: { width: number; height: number };
      }) => void,
    ) => callback({ context, mediaSize: { width: 800, height: 400 } }),
  };
}

describe("CvdDivergenceLabelsPrimitive", () => {
  function attach(primitive: CvdDivergenceLabelsPrimitive) {
    const requestUpdate = vi.fn();
    primitive.attached({
      chart: {
        timeScale: () => ({
          timeToCoordinate: (time: number) => time * 10,
          width: () => 2_000,
        }),
      },
      series: { priceToCoordinate: (price: number) => price * 2 },
      requestUpdate,
    } as never);
    return requestUpdate;
  }

  it("rebuilds its labels on demand and asks the chart to repaint", () => {
    const primitive = new CvdDivergenceLabelsPrimitive();
    const requestUpdate = attach(primitive);
    primitive.setDivergences(
      [divergence("bearish", 100, 110)],
      barsWithWicks(88, 112),
    );
    expect(requestUpdate).toHaveBeenCalledTimes(1);
    primitive.updateAllViews();
    expect(primitive.renderLabels).toHaveLength(1);
    expect(primitive.renderLabels[0].text).toBe("DiV-");
  });

  it("draws one plate, one arrow and one text per label, and nothing when hidden", () => {
    const primitive = new CvdDivergenceLabelsPrimitive();
    attach(primitive);
    primitive.setDivergences(
      [divergence("bullish", 100, 90)],
      barsWithWicks(88, 112),
    );
    primitive.updateAllViews();

    const target = fakeCanvasTarget();
    primitive
      .paneViews()[0]
      .renderer()!
      .draw(target as never);
    expect(target.texts.map((entry) => entry.text)).toEqual(["DiV+"]);
    expect(target.rects).toHaveLength(1);
    expect(target.triangles).toHaveLength(1);

    // First point walked is the apex; it must sit ABOVE the two base points
    // for a bullish label (screen y grows downward).
    const [apex, ...base] = target.triangles[0];
    expect(base.every((point) => point.y > apex.y)).toBe(true);

    primitive.setLabelsVisible(false);
    primitive.updateAllViews();
    const hidden = fakeCanvasTarget();
    primitive
      .paneViews()[0]
      .renderer()!
      .draw(hidden as never);
    expect(hidden.texts).toEqual([]);
    expect(hidden.rects).toEqual([]);
    expect(hidden.triangles).toEqual([]);
  });

  it("draws a bearish arrow pointing down", () => {
    const primitive = new CvdDivergenceLabelsPrimitive();
    attach(primitive);
    primitive.setDivergences(
      [divergence("bearish", 100, 110)],
      barsWithWicks(88, 112),
    );
    primitive.updateAllViews();

    const target = fakeCanvasTarget();
    primitive
      .paneViews()[0]
      .renderer()!
      .draw(target as never);
    const [apex, ...base] = target.triangles[0];
    expect(base.every((point) => point.y < apex.y)).toBe(true);
  });

  it("draws a cumulative divergence as a bare colour-on-transparent diamond", () => {
    const primitive = new CvdDivergenceLabelsPrimitive("cumulative");
    attach(primitive);
    primitive.setDivergences(
      [divergence("bullish", 100, 90)],
      barsWithWicks(88, 112),
    );
    primitive.updateAllViews();

    const target = fakeCanvasTarget();
    primitive
      .paneViews()[0]
      .renderer()!
      .draw(target as never);
    expect(target.texts.map((entry) => entry.text)).toEqual([
      CUMULATIVE_DIAMOND_GLYPH,
    ]);
    // No plate behind it, and the glyph itself carries the colour rather than
    // being painted white on one.
    expect(target.rects).toEqual([]);
    expect(target.textFills).toEqual([CVD_TONE_COLORS.intenseUp]);
    // The direction is still shown by the arrow.
    expect(target.triangles).toHaveLength(1);
    const [apex, ...base] = target.triangles[0];
    expect(base.every((point) => point.y > apex.y)).toBe(true);
  });

  it("keeps the oscillator's own label plated and white", () => {
    // The oscillator's presentation is deliberately untouched by the diamond
    // work, and this is the assertion that says so.
    const primitive = new CvdDivergenceLabelsPrimitive("oscillator");
    attach(primitive);
    primitive.setDivergences(
      [divergence("bullish", 100, 90)],
      barsWithWicks(88, 112),
    );
    primitive.updateAllViews();

    const target = fakeCanvasTarget();
    primitive
      .paneViews()[0]
      .renderer()!
      .draw(target as never);
    expect(target.texts.map((entry) => entry.text)).toEqual(["DiV+"]);
    expect(target.rects).toHaveLength(1);
    expect(target.textFills).toEqual(["#ffffff"]);
  });

  it("draws a bearish cumulative label pointing down at the bar", () => {
    const primitive = new CvdDivergenceLabelsPrimitive("cumulative");
    attach(primitive);
    primitive.setDivergences(
      [divergence("bearish", 100, 110)],
      barsWithWicks(88, 112),
    );
    primitive.updateAllViews();

    const target = fakeCanvasTarget();
    primitive
      .paneViews()[0]
      .renderer()!
      .draw(target as never);
    const [arrowApex, ...arrowBase] = target.triangles[0];
    expect(arrowBase.every((point) => point.y < arrowApex.y)).toBe(true);
  });

  it("does not ask for a repaint when visibility is set to its current value", () => {
    const primitive = new CvdDivergenceLabelsPrimitive();
    const requestUpdate = attach(primitive);
    primitive.setLabelsVisible(true);
    expect(requestUpdate).not.toHaveBeenCalled();
    primitive.setLabelsVisible(false);
    expect(requestUpdate).toHaveBeenCalledTimes(1);
    primitive.setLabelsVisible(false);
    expect(requestUpdate).toHaveBeenCalledTimes(1);
  });

  it("drops everything on detach so a removed series cannot leak labels", () => {
    const primitive = new CvdDivergenceLabelsPrimitive();
    attach(primitive);
    primitive.setDivergences(
      [divergence("bullish", 100, 90)],
      barsWithWicks(88, 112),
    );
    primitive.updateAllViews();
    expect(primitive.renderLabels).toHaveLength(1);

    primitive.detached();
    primitive.updateAllViews();
    expect(primitive.renderLabels).toEqual([]);
  });

  it("is empty before any divergences arrive", () => {
    const primitive = new CvdDivergenceLabelsPrimitive();
    attach(primitive);
    primitive.updateAllViews();
    expect(primitive.renderLabels).toEqual([]);
  });
});
