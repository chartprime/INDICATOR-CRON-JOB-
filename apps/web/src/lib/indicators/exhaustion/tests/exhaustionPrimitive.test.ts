import { describe, expect, it, vi } from "vitest";
import type { CandlestickData, UTCTimestamp } from "lightweight-charts";
import type { ExhaustionShade, ExhaustionShadesFrame } from "../../../../types/frames";
import { STATUS_BADGE_SLOT } from "../../../chart/statusBadge";
import { ExhaustionBook } from "../../../l2/exhaustionBook";
import { BOX_MIN_HEIGHT_PX, BROKEN_DASH, ExhaustionPrimitive, FLASH_HALF_PERIOD_MS, HOVER_RIM, HOVER_RIM_WIDTH, INTENSITY_SHARE, LEG_LABEL_PAD, LEG_OUTLINE_WIDTH, PENDING_SHARE, RIM_WIDTH, SCORE_LABEL_MIN_WIDTH, STRIP_SHARE, drawExhaustionBoxes, drawLegOutlines, exhaustionStatusText, flashLit, layoutExhaustion, legOutlinesOf, shadeAlpha, zoneStartTs, type ExhaustionBox } from "../exhaustionPrimitive";
import { DEFAULT_EXHAUSTION_SETTINGS } from "../exhaustionSettings";
import type { LegBar } from "../legCatcher";
import { DEFAULT_LIQUIDITY_SETTINGS } from "../../passive-liquidity/liquiditySettings";
import { parseRgb } from "../../passive-liquidity/liquidityHeatmapHost";
import { css } from "../../aggressive-orders/aggressiveOrdersRenderer";

const T = 1_790_000_000_000;

function shade(over: Partial<ExhaustionShade> = {}): ExhaustionShade {
  return {
    id: "s", candleMs: 60000, side: "buyers", status: "held", intensity: 3, score: 6, readings: { rate: true, progress: true, delta: true, divergence: true, prints: true, book: true }, values: { rate: 0.211, progress: 0, delta: -0.4, divergence: -1.4, prints: null, book: 0.5 },
    raw: { own: 3, other: 7, legOwn: 14.222, moved: 0, legMoved: 1.778, big: 0, legBig: 0, extremeOwn: 20, extremeOther: 0, bookNow: 1, bookAt: 2, bookBand: 0 },
    startTs: T, endTs: T + 60_000, extremeTs: T - 60_000, extremePrice: 210, legStartTs: T - 300_000, legStartPrice: 198,
    legSize: 12, efficiency: 1, atr: 1.5, judgedAt: T + 240_000, updatedAt: T + 240_000, origin: "runtime", ...over,
  };
}

// 1 px per second from T, 1 px per price unit from the bottom of a 1000 x 500 pane.
const geometry = { xOf: (ms: number) => (ms < T - 700_000 ? null : (ms - T) / 1000), yOf: (price: number) => (price > 1000 ? null : 500 - price), width: 1000, height: 500 };

interface Op { op: string; args: unknown[]; fillStyle: unknown; strokeStyle: unknown; lineWidth: unknown; dash: number[] }

function recordingContext() {
  const ops: Op[] = [];
  let dash: number[] = [];
  const context: Record<string, unknown> = { fillStyle: "", strokeStyle: "", lineWidth: 0, font: "", textAlign: "left", save() {}, restore() {}, setLineDash(next: number[]) { dash = [...next]; } };
  for (const op of ["fillRect", "strokeRect", "fillText"]) context[op] = (...args: unknown[]) => { ops.push({ op, args, fillStyle: context.fillStyle, strokeStyle: context.strokeStyle, lineWidth: context.lineWidth, dash: [...dash] }); };
  return { context: context as unknown as Parameters<typeof drawExhaustionBoxes>[0], ops };
}

const buyers = parseRgb(DEFAULT_LIQUIDITY_SETTINGS.askColor, "#000000");
const sellers = parseRgb(DEFAULT_LIQUIDITY_SETTINGS.bidColor, "#000000");

describe("layoutExhaustion", () => {
  it("boxes the leg from its start to the extreme and from the leg's first candle through the shade's last; the exhaustion box is the zone at the extreme, two fifths of the leg by default, over the shaded candles; mirrored for a fall", () => {
    const [box] = layoutExhaustion([shade()], geometry, T + 600_000, 0.6);
    expect(box).toMatchObject({ left: -300, width: 360, top: 500 - 210, height: 12, zoneLeft: 0, zoneWidth: 60, zoneTop: 500 - 210, state: "held", lit: true, alpha: 0.6 });
    expect(box.zoneHeight).toBeCloseTo(4.8);
    const [fall] = layoutExhaustion([shade({ side: "sellers", legStartPrice: 210, extremePrice: 198 })], geometry, T + 600_000, 0.6);
    expect(fall).toMatchObject({ left: -300, width: 360, top: 500 - 210, height: 12, zoneLeft: 0, zoneWidth: 60 });
    expect(fall.zoneTop).toBeCloseTo(500 - 198 - 4.8);
    expect(fall.zoneHeight).toBeCloseTo(4.8);
    const [flat] = layoutExhaustion([shade({ legStartPrice: 209 })], geometry, T + 600_000, 0.6);
    expect(flat).toMatchObject({ top: 500 - 210, height: BOX_MIN_HEIGHT_PX });
    const [flatFall] = layoutExhaustion([shade({ side: "sellers", legStartPrice: 199, extremePrice: 198 })], geometry, T + 600_000, 0.6);
    expect(flatFall).toMatchObject({ top: 500 - 198 - BOX_MIN_HEIGHT_PX, height: BOX_MIN_HEIGHT_PX });
    expect(layoutExhaustion([shade({ legSize: 1 })], geometry, T + 600_000, 0.6)[0]).toMatchObject({ zoneTop: 500 - 210, zoneHeight: BOX_MIN_HEIGHT_PX });
    expect(layoutExhaustion([shade({ side: "sellers", legStartPrice: 210, extremePrice: 198, legSize: 1 })], geometry, T + 600_000, 0.6)[0]).toMatchObject({ zoneTop: 500 - 198 - BOX_MIN_HEIGHT_PX, zoneHeight: BOX_MIN_HEIGHT_PX });
    expect(BOX_MIN_HEIGHT_PX).toBe(4);
  });

  it("the Exhaustion area slider scales the zone, a fifth of the leg at x1, the whole leg at x5", () => {
    expect(layoutExhaustion([shade({ legSize: 24 })], geometry, T + 600_000, 0.6, null, [], 1)[0].zoneHeight).toBeCloseTo(4.8);
    expect(layoutExhaustion([shade()], geometry, T + 600_000, 0.6, null, [], 5)[0]).toMatchObject({ zoneTop: 500 - 210, zoneHeight: 12 });
    const [fall] = layoutExhaustion([shade({ side: "sellers", legStartPrice: 210, extremePrice: 198 })], geometry, T + 600_000, 0.6, null, [], 5);
    expect(fall).toMatchObject({ zoneTop: 500 - 210, zoneHeight: 12 });
  });

  it("an open shade runs to now and flashes on the half second; the alpha follows the intensity", () => {
    const open = shade({ status: "open", judgedAt: null });
    expect(layoutExhaustion([open], geometry, T + 90_000, 0.6)[0]).toMatchObject({ state: "open", width: 390, zoneWidth: 90, lit: true });
    expect(layoutExhaustion([open], geometry, T + 90_500, 0.6)[0]).toMatchObject({ state: "open", width: 390.5, zoneWidth: 90.5, lit: false });
    expect(layoutExhaustion([open], geometry, T + 30_000, 0.6)[0]).toMatchObject({ width: 360, zoneWidth: 60 });
    expect([flashLit(0), flashLit(499), flashLit(500), flashLit(999), flashLit(1000)]).toEqual([true, true, false, false, true]);
    expect(FLASH_HALF_PERIOD_MS).toBe(500);
    expect(INTENSITY_SHARE).toEqual({ 1: 0.7, 2: 0.85, 3: 1 });
    expect([1, 2, 3].map((intensity) => shadeAlpha({ intensity }, 0.6))).toEqual([0.42, 0.51, 0.6]);
    expect(layoutExhaustion([shade({ intensity: 1 })], geometry, T, 0.6)[0].alpha).toBeCloseTo(0.42);
  });

  it("the exhaustion box reaches back over the run of the chart's candles touching the zone that ends at the shade's last candle, the shade's own candles always in, never past the leg's start", () => {
    const bar = (ms: number, high: number, low = 190): LegBar => ({ time: ms / 1000, open: 200, high, low, close: 200 });
    const rise = shade();
    const zone = 4.8;
    expect(zoneStartTs(rise, [], zone)).toBe(T);
    expect(zoneStartTs(rise, [bar(T - 300_000, 200), bar(T - 240_000, 203), bar(T - 180_000, 206), bar(T - 120_000, 204), bar(T - 60_000, 207), bar(T, 210), bar(T + 60_000, 209)], zone)).toBe(T - 60_000);
    expect(zoneStartTs(rise, [bar(T - 300_000, 200), bar(T - 240_000, 203), bar(T - 180_000, 206), bar(T - 120_000, 206), bar(T - 60_000, 207), bar(T, 210), bar(T + 60_000, 209)], zone)).toBe(T - 180_000);
    expect(zoneStartTs(rise, [bar(T - 300_000, 200), bar(T - 240_000, 203), bar(T - 180_000, 206), bar(T - 120_000, 206), bar(T - 60_000, 207), bar(T, 100), bar(T + 60_000, 209)], zone)).toBe(T - 180_000);
    expect(zoneStartTs(rise, [bar(T - 300_000, 200), bar(T - 240_000, 203), bar(T - 180_000, 204), bar(T - 120_000, 204), bar(T - 60_000, 204), bar(T, 210)], zone)).toBe(T);
    expect(zoneStartTs(shade({ legStartTs: T - 120_000 }), [bar(T - 300_000, 210), bar(T - 240_000, 210), bar(T - 180_000, 210), bar(T - 120_000, 210), bar(T - 60_000, 210), bar(T, 210)], zone)).toBe(T - 120_000);
    expect(zoneStartTs(rise, [bar(T - 300_000, 205.2), bar(T - 240_000, 205.19), bar(T - 180_000, 205.2), bar(T - 120_000, 205.2), bar(T - 60_000, 205.2), bar(T, 210)], zone)).toBe(T - 180_000);
    const fallBar = (ms: number, low: number): LegBar => ({ time: ms / 1000, open: 200, high: 215, low, close: 200 });
    const fall = shade({ side: "sellers", legStartPrice: 210, extremePrice: 198 });
    expect(zoneStartTs(fall, [fallBar(T - 300_000, 208), fallBar(T - 240_000, 202.8), fallBar(T - 180_000, 202.81), fallBar(T - 120_000, 202.8), fallBar(T - 60_000, 201), fallBar(T, 198)], zone)).toBe(T - 120_000);
    const bars = [bar(T - 300_000, 200), bar(T - 240_000, 203), bar(T - 180_000, 206), bar(T - 120_000, 204), bar(T - 60_000, 207), bar(T, 210), bar(T + 60_000, 209)];
    expect(layoutExhaustion([rise], geometry, T + 600_000, 0.6, null, bars)[0]).toMatchObject({ zoneLeft: -60, zoneWidth: 120, left: -300, width: 360 });
    expect(layoutExhaustion([rise], geometry, T + 600_000, 0.6, null, bars, 1)[0]).toMatchObject({ zoneLeft: 0, zoneWidth: 60 });
    expect(layoutExhaustion([rise], geometry, T + 600_000, 0.6, null, bars, 5)[0]).toMatchObject({ zoneLeft: -300, zoneWidth: 360 });
  });

  it("a shade off the pane or before the chart's reach is left out", () => {
    expect(layoutExhaustion([shade({ legStartTs: T - 900_000 })], geometry, T, 0.6)).toEqual([]);
    expect(layoutExhaustion([shade({ extremePrice: 1200, legStartPrice: 1100 })], geometry, T, 0.6)).toEqual([]);
    expect(layoutExhaustion([shade({ legStartTs: T + 1_500_000, extremeTs: T + 1_560_000, startTs: T + 1_620_000, endTs: T + 1_680_000 })], geometry, T, 0.6)).toEqual([]);
  });
});

describe("drawExhaustionBoxes", () => {
  const box = (over: Partial<ExhaustionBox> = {}): ExhaustionBox => ({ left: 10, top: 20, width: 100, height: 30, zoneLeft: 80, zoneTop: 20, zoneWidth: 30, zoneHeight: 12, state: "held", lit: true, hovered: false, alpha: 0.6, shade: shade(), ...over });

  it("a held shade is the exhaustion box alone: the zone filled strong, with a solid rim in the side's colour, the leg left blank", () => {
    const { context, ops } = recordingContext();
    drawExhaustionBoxes(context, [box()], DEFAULT_EXHAUSTION_SETTINGS);
    expect(ops.map((op) => [op.op, op.args])).toEqual([
      ["fillRect", [80, 20, 30, 12]],
      ["strokeRect", [80 + RIM_WIDTH / 2, 20 + RIM_WIDTH / 2, 30 - RIM_WIDTH, 12 - RIM_WIDTH]],
    ]);
    expect(ops[0].fillStyle).toBe(css(buyers, 0.6 * STRIP_SHARE));
    expect(STRIP_SHARE).toBe(1);
    expect(ops[1]).toMatchObject({ strokeStyle: css(buyers, 0.8), lineWidth: RIM_WIDTH, dash: [] });
  });

  it("an open shade fills only while lit, its rim solid; broke and interrupted are dotted rims around the exhaustion box only", () => {
    const { context, ops } = recordingContext();
    drawExhaustionBoxes(context, [box({ state: "open", lit: false }), box({ state: "broke" }), box({ state: "interrupted", shade: shade({ side: "sellers" }) })], DEFAULT_EXHAUSTION_SETTINGS);
    expect(ops.map((op) => [op.op, op.dash])).toEqual([
      ["strokeRect", []],
      ["strokeRect", BROKEN_DASH],
      ["strokeRect", BROKEN_DASH],
    ]);
    expect(ops[1].args).toEqual([80 + RIM_WIDTH / 2, 20 + RIM_WIDTH / 2, 30 - RIM_WIDTH, 12 - RIM_WIDTH]);
    expect(ops[2].strokeStyle).toBe(css(sellers, 0.8));
  });

  it("a shade waiting for its verdict fills at half and holds still: no flash, its box fixed at its last firing close", () => {
    const { context, ops } = recordingContext();
    drawExhaustionBoxes(context, [box({ state: "pending", zoneWidth: SCORE_LABEL_MIN_WIDTH - 1 })], DEFAULT_EXHAUSTION_SETTINGS);
    expect(ops.map((op) => [op.op, op.dash])).toEqual([["fillRect", []], ["strokeRect", []]]);
    expect(ops[0].fillStyle).toBe(css(buyers, 0.6 * STRIP_SHARE * PENDING_SHARE));
    expect(PENDING_SHARE).toBe(0.5);
    const waiting = shade({ status: "pending", judgedAt: null });
    for (const now of [T + 90_000, T + 90_500]) expect(layoutExhaustion([waiting], geometry, now, 0.6)[0]).toMatchObject({ state: "pending", lit: true, width: 360, zoneWidth: 60 });
  });

  it("an exhaustion box wide enough carries the score and its measured accuracy at its top, in the side's colour, whatever the verdict", () => {
    const { context, ops } = recordingContext();
    drawExhaustionBoxes(context, [box({ zoneWidth: SCORE_LABEL_MIN_WIDTH }), box({ state: "broke", zoneWidth: 60, zoneTop: 50, shade: shade({ score: 3, intensity: 1 }) }), box({ zoneWidth: SCORE_LABEL_MIN_WIDTH - 1 })], DEFAULT_EXHAUSTION_SETTINGS);
    expect(ops.filter((op) => op.op === "fillText").map((op) => [op.args, op.fillStyle])).toEqual([
      [["6/6 · ~69%", 80 + LEG_LABEL_PAD, 30], css(buyers, 1)],
      [["3/6 · ~57%", 80 + LEG_LABEL_PAD, 60], css(buyers, 1)],
    ]);
    const off = recordingContext();
    drawExhaustionBoxes(off.context, [box({ zoneWidth: 60 })], { ...DEFAULT_EXHAUSTION_SETTINGS, legAtr: 6 });
    expect(off.ops.filter((op) => op.op === "fillText").map((op) => op.args[0])).toEqual(["6/6"]);
    expect(ops.map((op) => op.op)).toEqual(["fillRect", "fillText", "strokeRect", "fillText", "strokeRect", "fillRect", "strokeRect"]);
  });

  it("the hovered shade gets the dark rim around its exhaustion box, not its leg, like a whale level under the cursor", () => {
    const { context, ops } = recordingContext();
    drawExhaustionBoxes(context, [box({ hovered: true }), box({ state: "broke", hovered: true, left: 300, zoneLeft: 370, zoneTop: 30 })], DEFAULT_EXHAUSTION_SETTINGS);
    const rims = ops.filter((op) => op.strokeStyle === HOVER_RIM);
    expect(rims.map((op) => [op.op, op.args, op.lineWidth, op.dash])).toEqual([
      ["strokeRect", [79, 18.5, 32, 15], HOVER_RIM_WIDTH, []],
      ["strokeRect", [369, 28.5, 32, 15], HOVER_RIM_WIDTH, []],
    ]);
    expect(ops.indexOf(rims[0])).toBe(2);
    expect(layoutExhaustion([shade()], geometry, T + 600_000, 0.6, "s")[0].hovered).toBe(true);
    expect(layoutExhaustion([shade()], geometry, T + 600_000, 0.6, "other")[0].hovered).toBe(false);
    expect(layoutExhaustion([shade()], geometry, T + 600_000, 0.6)[0].hovered).toBe(false);
  });

  it("the trader's colours replace the heatmap's", () => {
    const { context, ops } = recordingContext();
    drawExhaustionBoxes(context, [box({ shade: shade({ side: "sellers" }) })], { ...DEFAULT_EXHAUSTION_SETTINGS, sellerColor: "#123456" });
    expect(ops[0].fillStyle).toBe(css(parseRgb("#123456", "#000000"), 0.6 * STRIP_SHARE));
  });
});

describe("legOutlinesOf and drawLegOutlines", () => {
  const box = (over: Partial<ExhaustionBox> = {}): ExhaustionBox => ({ left: 10, top: 20, width: 100, height: 30, zoneLeft: 80, zoneTop: 20, zoneWidth: 30, zoneHeight: 12, state: "held", lit: true, hovered: false, alpha: 0.6, shade: shade(), ...over });

  it("one blank leg per shade, from the leg's start to the shade's end, in the side's colour, a thin continuous line whatever the verdict", () => {
    const { context, ops } = recordingContext();
    const outlines = legOutlinesOf([box({ state: "broke" }), box({ left: 300, top: 100, width: 50, height: 10, alpha: 0.42, shade: shade({ id: "fall", side: "sellers", legStartTs: T + 100_000, legStartPrice: 300 }) })]);
    expect(outlines).toEqual([
      { left: 10, top: 20, width: 100, height: 30, side: "buyers", alpha: 0.6 },
      { left: 300, top: 100, width: 50, height: 10, side: "sellers", alpha: 0.42 },
    ]);
    drawLegOutlines(context, outlines, { ...DEFAULT_EXHAUSTION_SETTINGS, sellerColor: "#123456" });
    expect(ops.map((op) => [op.op, op.args, op.strokeStyle, op.lineWidth, op.dash])).toEqual([
      ["strokeRect", [10 + LEG_OUTLINE_WIDTH / 2, 20 + LEG_OUTLINE_WIDTH / 2, 100 - LEG_OUTLINE_WIDTH, 30 - LEG_OUTLINE_WIDTH], css(buyers, 0.8), LEG_OUTLINE_WIDTH, []],
      ["strokeRect", [300 + LEG_OUTLINE_WIDTH / 2, 100 + LEG_OUTLINE_WIDTH / 2, 50 - LEG_OUTLINE_WIDTH, 10 - LEG_OUTLINE_WIDTH], css(parseRgb("#123456", "#000000"), 0.62), LEG_OUTLINE_WIDTH, []],
    ]);
    expect(LEG_OUTLINE_WIDTH).toBe(1);
  });

  it("shades of one leg share one outline, drawn once up to the furthest extreme and the latest end, at the strongest alpha; the same leg on the other side is another", () => {
    const early = box({ left: 10, top: 40, width: 60, height: 10, alpha: 0.42, shade: shade({ id: "early", intensity: 1 }) });
    const late = box({ left: 10, top: 20, width: 100, height: 30, alpha: 0.6, shade: shade({ id: "late" }) });
    const fallEarly = box({ left: 10, top: 20, width: 60, height: 10, alpha: 0.42, shade: shade({ id: "fall-early", side: "sellers", intensity: 1 }) });
    const other = box({ left: 10, top: 20, width: 100, height: 30, alpha: 0.6, shade: shade({ id: "fall", side: "sellers" }) });
    expect(legOutlinesOf([early, late, fallEarly, other])).toEqual([
      { left: 10, top: 20, width: 100, height: 30, side: "buyers", alpha: 0.6 },
      { left: 10, top: 20, width: 100, height: 30, side: "sellers", alpha: 0.6 },
    ]);
    expect(legOutlinesOf([late, early])).toEqual([{ left: 10, top: 20, width: 100, height: 30, side: "buyers", alpha: 0.6 }]);
    expect(legOutlinesOf([early, box({ left: 10, top: 20, width: 100, height: 30, shade: shade({ id: "next", legStartTs: T - 200_000 }) })])).toHaveLength(2);
    expect(legOutlinesOf([early, box({ left: 10, top: 20, width: 100, height: 30, shade: shade({ id: "next", legStartPrice: 199 }) })])).toHaveLength(2);
  });
});

describe("exhaustionStatusText", () => {
  it("says when the runtime has not answered and when the book is untrusted; a timeframe with nothing fired just shows nothing", () => {
    const book = new ExhaustionBook();
    expect(exhaustionStatusText(null)).toBe("EXHAUSTION · WAITING FOR THE RUNTIME");
    expect(exhaustionStatusText(book)).toBe("EXHAUSTION · UNTRUSTED UNTIL THE NEXT PAGE");
    book.apply(frameOf([]));
    expect(exhaustionStatusText(book)).toBeNull();
    book.markUntrusted();
    expect(exhaustionStatusText(book)).toBe("EXHAUSTION · UNTRUSTED UNTIL THE NEXT PAGE");
    expect(STATUS_BADGE_SLOT.exhaustion).toBe(8);
  });

  it("says what span of history the runtime is reading while a page carries loading, named like the heatmap's reaches, and nothing once it is null again", () => {
    const book = new ExhaustionBook();
    book.apply(frameOf([], { loading: T - 86_400_000 }));
    expect(exhaustionStatusText(book)).toBe("EXHAUSTION · LOADING 1 DAY");
    book.apply(frameOf([], { seq: 1, ts: T + 1, loading: T - 3 * 86_400_000 }));
    expect(exhaustionStatusText(book)).toBe("EXHAUSTION · LOADING 3 DAYS");
    book.apply(frameOf([], { seq: 2, ts: T + 2, loading: T - 7 * 86_400_000 + 2000 }));
    expect(exhaustionStatusText(book)).toBe("EXHAUSTION · LOADING 1 WEEK");
    book.apply(frameOf([], { seq: 3, ts: T + 3, loading: T - 4 * 86_400_000 }));
    expect(exhaustionStatusText(book)).toBe("EXHAUSTION · LOADING 4 DAYS");
    book.markUntrusted();
    expect(exhaustionStatusText(book)).toBe("EXHAUSTION · UNTRUSTED UNTIL THE NEXT PAGE");
    book.apply(frameOf([], { seq: 4, ts: T + 4, loading: null }));
    expect(exhaustionStatusText(book)).toBeNull();
  });
});

function frameOf(shades: ExhaustionShade[], over: Partial<ExhaustionShadesFrame> = {}): ExhaustionShadesFrame {
  const base: ExhaustionShadesFrame = { type: "exhaustion_shades", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL", ts: T, seq: 0, reset: true, shades, liveSince: T - 3_600_000, loading: null };
  return { ...base, ...over } as ExhaustionShadesFrame;
}

function fakeChart(bars: readonly CandlestickData<UTCTimestamp>[], scale = 1) {
  const calls: string[] = [];
  const chart = {
    timeScale: () => ({ width: () => 1000, options: () => ({ barSpacing: 60 * scale }), timeToCoordinate: (time: number) => (time - bars[0].time) * scale }),
    paneSize: () => ({ height: 500 }),
  };
  const series = { data: () => bars, priceToCoordinate: (price: number) => 500 - price };
  return { chart, series, calls, attach: (primitive: ExhaustionPrimitive) => primitive.attached({ chart, series, requestUpdate: () => calls.push("update") } as never) };
}

describe("ExhaustionPrimitive", () => {
  const bars: CandlestickData<UTCTimestamp>[] = Array.from({ length: 40 }, (_, i) => ({ time: ((T - 20 * 60_000) / 1000 + i * 60) as UTCTimestamp, open: 200, high: 201, low: 199, close: 200 }));

  it("draws the book's shades of the chart's candle length through the settings' filter, answers hover over the exhaustion box, draws the leg outline unless areas only, and empties when the book or the candle goes", () => {
    const now = { at: T + 30_000 };
    const primitive = new ExhaustionPrimitive(() => bars, () => now.at);
    const fake = fakeChart(bars);
    fake.attach(primitive);
    const book = new ExhaustionBook();
    book.apply(frameOf([shade(), shade({ id: "5m", candleMs: 300000 })]));
    primitive.setCandleMs(60_000);
    primitive.setShown(true);
    primitive.setBook(book);
    primitive.updateAllViews();
    expect(primitive.boxes.map((box) => box.shade.id)).toEqual(["s"]);
    const [box] = primitive.boxes;
    expect(box.zoneTop).toBe(box.top);
    expect(box.zoneHeight).toBeCloseTo(4.8);
    expect(box.height).toBe(12);
    expect(primitive.boxAt(box.zoneLeft + 1, box.top + 1)?.title).toBe("Buyers exhausted · 6/6 · ~69% · held");
    expect(primitive.boxAt(box.zoneLeft + 1, box.top + 1)?.short).toBe("Buyers exhausted · 6/6");
    primitive.setUnit("BTC");
    expect(primitive.boxAt(box.zoneLeft + 1, box.top + 1)?.lines[0]).toEqual({ key: "rate", label: "Buying volume", value: "3.00 BTC", detail: "Leg: 14.2", counted: true });
    expect(box.zoneLeft).toBeGreaterThan(box.left + 5);
    expect(primitive.boxAt(box.left + 1, box.top + 1)).toBeNull();
    expect(primitive.boxAt(box.zoneLeft - 1, box.top + 1)).toBeNull();
    expect(primitive.boxAt(box.zoneLeft + box.zoneWidth + 1, box.top + 1)).toBeNull();
    expect(primitive.boxAt(box.zoneLeft + 1, box.top - 1)).toBeNull();
    expect(primitive.boxAt(box.zoneLeft + 1, box.zoneTop + box.zoneHeight + 1)).toBeNull();
    expect(primitive.boxAt(box.zoneLeft + 1, box.top + box.height - 1)).toBeNull();
    const drawn = recordingContext();
    const draw = (into: ReturnType<typeof recordingContext>) => primitive.paneViews()[0].renderer()!.draw({ useMediaCoordinateSpace: (paint: (scope: { context: unknown }) => void) => paint({ context: into.context }) } as never);
    draw(drawn);
    expect(drawn.ops.map((op) => [op.op, op.args, op.lineWidth, op.dash])).toEqual([
      ["strokeRect", [box.left + LEG_OUTLINE_WIDTH / 2, box.top + LEG_OUTLINE_WIDTH / 2, box.width - LEG_OUTLINE_WIDTH, box.height - LEG_OUTLINE_WIDTH], LEG_OUTLINE_WIDTH, []],
      ["fillRect", [box.zoneLeft, box.zoneTop, box.zoneWidth, box.zoneHeight], RIM_WIDTH, []],
      ["fillText", ["6/6 · ~69%", box.zoneLeft + LEG_LABEL_PAD, box.zoneTop + 10], RIM_WIDTH, []],
      ["strokeRect", [box.zoneLeft + RIM_WIDTH / 2, box.zoneTop + RIM_WIDTH / 2, box.zoneWidth - RIM_WIDTH, box.zoneHeight - RIM_WIDTH], RIM_WIDTH, []],
    ]);
    primitive.setSettings({ ...DEFAULT_EXHAUSTION_SETTINGS, zonesOnly: true });
    primitive.updateAllViews();
    const only = recordingContext();
    draw(only);
    expect(only.ops.map((op) => [op.op, op.args])).toEqual(drawn.ops.slice(1).map((op) => [op.op, op.args]));
    primitive.setSettings({ ...DEFAULT_EXHAUSTION_SETTINGS, zoneScale: 5 });
    primitive.updateAllViews();
    expect(primitive.boxes[0]).toMatchObject({ zoneTop: box.top, zoneHeight: box.height });
    expect(primitive.boxAt(box.zoneLeft + 1, box.top + box.height - 1)?.id).toBe("s");
    primitive.setSettings(DEFAULT_EXHAUSTION_SETTINGS);
    primitive.updateAllViews();
    primitive.setHover("s");
    primitive.updateAllViews();
    expect(primitive.boxes[0].hovered).toBe(true);
    primitive.setHover(null);
    primitive.updateAllViews();
    expect(primitive.boxes[0].hovered).toBe(false);
    primitive.setCandleMs(300_000);
    primitive.updateAllViews();
    expect(primitive.boxes.map((box) => box.shade.id)).toEqual(["5m"]);
    primitive.setBook(null);
    primitive.updateAllViews();
    expect(primitive.boxes).toEqual([]);
    expect(primitive.shown).toBe(true);
    primitive.setShown(false);
    primitive.updateAllViews();
    expect(primitive.legBoxes).toEqual([]);
    expect(primitive.shown).toBe(false);
    primitive.detached();
  });

  it("two shades of one leg nest; the cursor opens the one whose exhaustion box it is on and nothing over the blank leg", () => {
    const now = { at: T + 30_000 };
    const primitive = new ExhaustionPrimitive(() => bars, () => now.at);
    const fake = fakeChart(bars);
    fake.attach(primitive);
    const book = new ExhaustionBook();
    const early = shade({ id: "early", status: "pending", judgedAt: null, startTs: T - 240_000, endTs: T - 180_000, extremeTs: T - 300_000, extremePrice: 206, legStartTs: T - 600_000, legStartPrice: 198 });
    const late = shade({ id: "late", status: "open", judgedAt: null, startTs: T - 60_000, endTs: T, extremeTs: T - 120_000, extremePrice: 210, legStartTs: T - 600_000, legStartPrice: 198 });
    book.apply(frameOf([early, late]));
    primitive.setCandleMs(60_000);
    primitive.setShown(true);
    primitive.setBook(book);
    primitive.updateAllViews();
    const [outer, inner] = [primitive.boxes.find((b) => b.shade.id === "late")!, primitive.boxes.find((b) => b.shade.id === "early")!];
    expect(outer.left).toBe(inner.left);
    expect(outer.left + outer.width).toBeGreaterThan(inner.left + inner.width);
    expect(outer.top).toBeLessThan(inner.top);
    expect(primitive.boxAt(inner.zoneLeft + 1, inner.top + 1)?.id).toBe("early");
    expect(primitive.boxAt(inner.left + 1, inner.top + 1)).toBeNull();
    expect(primitive.boxAt(outer.zoneLeft + 1, outer.top + 1)?.id).toBe("late");
    expect(primitive.boxAt(inner.left + 1, outer.top + 1)).toBeNull();
    primitive.setSettings({ ...DEFAULT_EXHAUSTION_SETTINGS, legEfficiency: 0.45 });
    primitive.updateAllViews();
    expect(primitive.boxAt(inner.zoneLeft + 1, inner.top + 1)?.title).toBe("Buyers exhausted · 6/6 · waiting for the verdict");
    primitive.detached();
  });

  it("where exhaustion boxes of different legs overlap, the smaller answers; a blank leg answers nothing", () => {
    const now = { at: T + 120_000 };
    const primitive = new ExhaustionPrimitive(() => bars, () => now.at);
    const fake = fakeChart(bars, 0.5);
    fake.attach(primitive);
    const book = new ExhaustionBook();
    const big = shade({ id: "big", startTs: T - 180_000, endTs: T, extremeTs: T - 240_000, extremePrice: 210, legStartTs: T - 600_000, legStartPrice: 198 });
    const small = shade({ id: "small", side: "sellers", startTs: T - 60_000, endTs: T, extremeTs: T - 120_000, extremePrice: 204, legStartTs: T - 120_000, legStartPrice: 208 });
    book.apply(frameOf([big, small]));
    primitive.setCandleMs(60_000);
    primitive.setShown(true);
    primitive.setBook(book);
    primitive.updateAllViews();
    const wideBox = primitive.boxes.find((b) => b.shade.id === "big")!;
    const narrow = primitive.boxes.find((b) => b.shade.id === "small")!;
    const y = wideBox.zoneTop + wideBox.zoneHeight - 0.5;
    expect(narrow.zoneLeft).toBe(narrow.left);
    expect(narrow.zoneLeft).toBeGreaterThan(wideBox.zoneLeft);
    expect(wideBox.zoneLeft).toBeGreaterThan(wideBox.left);
    expect(narrow.zoneTop).toBeGreaterThan(wideBox.zoneTop);
    expect(narrow.zoneTop).toBeLessThan(y);
    expect(narrow.zoneWidth * narrow.zoneHeight).toBeLessThan(wideBox.zoneWidth * wideBox.zoneHeight);
    expect(primitive.boxAt(narrow.zoneLeft + 1, y)?.id).toBe("small");
    expect(primitive.boxAt(wideBox.zoneLeft + 1, y)?.id).toBe("big");
    expect(primitive.boxAt(narrow.zoneLeft + 1, wideBox.zoneTop + 0.5)?.id).toBe("big");
    expect(primitive.boxAt(wideBox.left + 1, y)).toBeNull();
    expect(primitive.boxAt(wideBox.left + 1, wideBox.top + 1)).toBeNull();
    primitive.detached();
  });

  it("draws the legs the chart's candles make only when their switch is on, off by default, with or without the runtime's book", () => {
    const now = { at: T + 30_000 };
    const legBars: CandlestickData<UTCTimestamp>[] = [
      ...Array.from({ length: 20 }, (_, i) => ({ time: ((T - 40 * 60_000) / 1000 + i * 60) as UTCTimestamp, open: 200, high: 200.5, low: 199.5, close: 200 })),
      ...Array.from({ length: 12 }, (_, i) => ({ time: ((T - 20 * 60_000) / 1000 + i * 60) as UTCTimestamp, open: 200 + i, high: 201 + i, low: 200 + i, close: 201 + i })),
    ];
    const primitive = new ExhaustionPrimitive(() => legBars, () => now.at);
    const fake = fakeChart(legBars, 0.5);
    fake.attach(primitive);
    primitive.setShown(true);
    primitive.updateAllViews();
    expect(primitive.legBoxes).toEqual([]);
    primitive.setSettings({ ...DEFAULT_EXHAUSTION_SETTINGS, showLegs: true });
    primitive.updateAllViews();
    expect(primitive.legs.map((leg) => [leg.side, leg.open, leg.sizeAtr])).toEqual([["up", true, 12.5]]);
    expect(primitive.legBoxes).toHaveLength(1);
    expect(primitive.legBoxes[0]).toMatchObject({ left: 555, width: 360, top: 500 - 212, height: 12.5 });
    primitive.setSettings({ ...DEFAULT_EXHAUSTION_SETTINGS, showLegs: true, legAtr: 20 });
    primitive.updateAllViews();
    expect(primitive.legBoxes).toEqual([]);
    primitive.setSettings({ ...DEFAULT_EXHAUSTION_SETTINGS, showLegs: true });
    primitive.updateAllViews();
    expect(primitive.legBoxes).toHaveLength(1);
    primitive.setSettings({ ...DEFAULT_EXHAUSTION_SETTINGS, showLegs: false });
    primitive.updateAllViews();
    expect(primitive.legBoxes).toEqual([]);
    primitive.detached();
  });

  it("asks the chart to repaint on every change, keeps flashing while a shade is open, and stops once none is", async () => {
    const now = { at: T + 30_000 };
    const primitive = new ExhaustionPrimitive(() => bars, () => now.at);
    const fake = fakeChart(bars);
    fake.attach(primitive);
    const book = new ExhaustionBook();
    book.apply(frameOf([shade({ status: "open", judgedAt: null })]));
    primitive.setCandleMs(60_000);
    primitive.setShown(true);
    primitive.setBook(book);
    primitive.updateAllViews();
    expect(primitive.boxes[0].state).toBe("open");
    await new Promise((resolve) => setTimeout(resolve, 40));
    const painted = fake.calls.length;
    expect(painted).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, FLASH_HALF_PERIOD_MS + 250));
    expect(fake.calls.length).toBeGreaterThan(painted);
    book.apply(frameOf([shade({ status: "held" })], { seq: 1 }));
    primitive.refresh();
    primitive.updateAllViews();
    expect(primitive.boxes[0].state).toBe("held");
    primitive.detached();
    expect(primitive.boxes).toEqual([]);
  });

  it("filters the book once per book version, settings object, candle length and minute, not on every view update; the boxes still follow each change", () => {
    const now = { at: T + 30_000 };
    const primitive = new ExhaustionPrimitive(() => bars, () => now.at);
    fakeChart(bars).attach(primitive);
    const book = new ExhaustionBook();
    book.apply(frameOf([shade()]));
    const list = vi.spyOn(book, "list");
    primitive.setCandleMs(60_000);
    primitive.setShown(true);
    primitive.setBook(book);
    primitive.updateAllViews();
    primitive.updateAllViews();
    primitive.updateAllViews();
    expect(list).toHaveBeenCalledTimes(1);
    expect(primitive.boxes.map((box) => box.shade.id)).toEqual(["s"]);
    book.apply(frameOf([shade({ id: "t", score: 5, intensity: 2, startTs: T + 60_000, endTs: T + 120_000 })], { reset: false, seq: 1 }));
    primitive.updateAllViews();
    expect(list).toHaveBeenCalledTimes(2);
    expect(primitive.boxes.map((box) => box.shade.id)).toEqual(["s", "t"]);
    primitive.updateAllViews();
    expect(list).toHaveBeenCalledTimes(2);
    const stricter = { ...DEFAULT_EXHAUSTION_SETTINGS, minScore: 6 };
    primitive.setSettings(stricter);
    primitive.updateAllViews();
    expect(list).toHaveBeenCalledTimes(3);
    expect(primitive.boxes.map((box) => box.shade.id)).toEqual(["s"]);
    primitive.setSettings(stricter);
    primitive.updateAllViews();
    expect(list).toHaveBeenCalledTimes(3);
    primitive.setCandleMs(300_000);
    primitive.updateAllViews();
    expect(list).toHaveBeenCalledTimes(4);
    expect(primitive.boxes).toEqual([]);
    primitive.setCandleMs(60_000);
    primitive.updateAllViews();
    expect(list).toHaveBeenCalledTimes(5);
    now.at += 5_000;
    primitive.updateAllViews();
    expect(list).toHaveBeenCalledTimes(5);
    now.at += 60_000;
    primitive.updateAllViews();
    expect(list).toHaveBeenCalledTimes(6);
    const other = new ExhaustionBook();
    other.apply(frameOf([shade()]));
    primitive.setBook(other);
    primitive.updateAllViews();
    expect(list).toHaveBeenCalledTimes(6);
    expect(primitive.boxes.map((box) => box.shade.id)).toEqual(["s"]);
    primitive.detached();
  });
});
