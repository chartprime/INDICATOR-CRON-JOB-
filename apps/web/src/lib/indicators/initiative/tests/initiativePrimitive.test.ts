import { describe, expect, it, vi } from "vitest";
import type { CandlestickData, UTCTimestamp } from "lightweight-charts";
import type { InitiativeBand, InitiativeBandsFrame } from "../../../../types/frames";
import { STATUS_BADGE_SLOT } from "../../../chart/statusBadge";
import { InitiativeBook } from "../../../l2/initiativeBook";
import { CHIP, CHIP_DETAIL_FONT, CHIP_DETAIL_INK, CHIP_EDGE, CHIP_FILL, CHIP_GAP, CHIP_HIT_SLACK, CHIP_RIM_ALPHA, CHIP_TITLE, CHIP_TITLE_FONT, CHIP_TITLE_INK, CHIP_VALUE_FONT, CHIP_VALUE_INK, InitiativePrimitive, LEADER_GAP, LEADER_LENGTH, LEADER_WIDTH, SHADE_CORE, SHADE_FADE, SHADE_HOVER_BOOST, candlesBetween, chipTextWidth, chipWidthOf, drawInitiativeMarks, drawInitiativeShades, initiativeStatusText, insideChip, insideShade, layoutInitiative, markHit, shadeArea, type InitiativeCandle, type InitiativeGeometry, type InitiativeMark } from "../initiativePrimitive";
import { DEFAULT_BUYER_COLOR, DEFAULT_INITIATIVE_SETTINGS, DEFAULT_SELLER_COLOR } from "../initiativeSettings";
import { parseRgb } from "../../passive-liquidity/liquidityHeatmapHost";
import { css } from "../../aggressive-orders/aggressiveOrdersRenderer";

const T = 1_790_000_000_000;

function band(over: Partial<InitiativeBand> = {}): InitiativeBand {
  return {
    id: "b", candleMs: 60000, side: "up", dominant: "buyers", dominantShare: 0.9, score: 4,
    facts: { efficiency: { yes: true, value: 1 }, closes: { yes: true, value: 1 }, burst: { yes: false, value: 1.667 }, delta: { yes: true, rank: 0.85, share: 0.9 }, prints: { yes: true, rank: 1, perCandle: 1 } },
    pivotTs: T - 180_000, pivotPrice: 198, frozenTs: T, frozenPrice: 210, windowCandles: 3, atr: 1.5,
    legExtremePrice: 214, legExtremeTs: T + 120_000, legEndTs: null, updatedAt: T + 180_000, origin: "runtime", ...over,
  };
}

// 1 px per second from T, 1 px per price unit from the bottom of a 1000 x 500 pane.
function geometryWith(candles: readonly InitiativeCandle[] = []): InitiativeGeometry {
  return {
    xOf: (ms: number) => (ms < T - 700_000 ? null : (ms - T) / 1000),
    yOf: (price: number) => (price > 1000 ? null : 500 - price),
    candles: (fromTs, toTs) => candles.filter((candle) => candle.ts >= fromTs && candle.ts <= toTs),
    width: 1000,
    height: 500,
  };
}
const geometry = geometryWith();
const candle = (ts: number, low: number, high: number): InitiativeCandle => ({ ts, low, high });

interface Op { op: string; args: unknown[]; fillStyle: unknown; strokeStyle: unknown; lineWidth: unknown; font: unknown }
interface Gradient { args: number[]; stops: [number, string][]; addColorStop: (offset: number, colour: string) => void }

function recordingContext() {
  const ops: Op[] = [];
  const gradients: Gradient[] = [];
  const context: Record<string, unknown> = { fillStyle: "", strokeStyle: "", lineWidth: 0, font: "", textAlign: "left", textBaseline: "alphabetic", save() {}, restore() {}, setLineDash() {} };
  const record = (op: string, args: unknown[]) => ops.push({ op, args, fillStyle: context.fillStyle, strokeStyle: context.strokeStyle, lineWidth: context.lineWidth, font: context.font });
  for (const op of ["beginPath", "moveTo", "lineTo", "arcTo", "closePath", "stroke", "fill", "fillText", "fillRect"]) context[op] = (...args: unknown[]) => record(op, args);
  context.createLinearGradient = (...args: number[]) => {
    const gradient: Gradient = { args, stops: [], addColorStop: (offset, colour) => { gradient.stops.push([offset, colour]); } };
    gradients.push(gradient);
    record("createLinearGradient", args);
    return gradient;
  };
  return { context: context as unknown as Parameters<typeof drawInitiativeShades>[0] & Parameters<typeof drawInitiativeMarks>[0], ops, gradients };
}

const buyers = parseRgb(DEFAULT_BUYER_COLOR, "#000000");
const sellers = parseRgb(DEFAULT_SELLER_COLOR, "#000000");
const CHIP_WIDTH = chipWidthOf({ title: CHIP_TITLE, value: "4/5", detail: "buyers" });

describe("layoutInitiative", () => {
  it("shades exactly the window: from the pivot candle's open to the flip candle's close, from the highest high to the lowest low of its chart candles, no wider and no taller at any zoom, the fade kept inside; the alpha is the opacity", () => {
    const [mark] = layoutInitiative([band()], geometry, 0.6);
    expect(mark.shade).toEqual({ left: -180, right: 60, top: 290, bottom: 302, fade: 6 });
    expect([mark.alpha, mark.hovered, mark.showShade]).toEqual([0.6, false, true]);
    expect([SHADE_CORE, SHADE_HOVER_BOOST, SHADE_FADE, LEADER_GAP]).toEqual([0.4, 1.6, 40, 4]);
    expect(shadeArea(mark.shade)).toBe(240 * 12);
    const window = [candle(T - 180_000, 196, 199), candle(T - 120_000, 199, 203), candle(T - 60_000, 197, 204), candle(T, 205, 212)];
    const [wide] = layoutInitiative([band()], geometryWith(window), 0.6);
    expect(wide.shade).toEqual({ left: -180, right: 60, top: 288, bottom: 304, fade: 8 });
    const [fall] = layoutInitiative([band({ side: "down", dominant: "sellers", pivotPrice: 210, frozenPrice: 198, legExtremePrice: 194 })], geometry, 0.6);
    expect(fall.shade).toEqual({ left: -180, right: 60, top: 290, bottom: 302, fade: 6 });
    const [tall] = layoutInitiative([band({ pivotPrice: 100, frozenPrice: 300, legExtremePrice: 320 })], geometry, 0.6);
    expect(tall.shade).toEqual({ left: -180, right: 60, top: 200, bottom: 400, fade: SHADE_FADE });
    const tight = { ...geometry, xOf: (ms: number) => (ms - T) / 1000 / 100 };
    const [narrow] = layoutInitiative([band()], tight, 0.6);
    expect([narrow.shade.left, narrow.shade.right]).toEqual([-1.8, 0.6]);
  });

  it("the chip hangs below an up leg's shade and above a down leg's, a leader's length past a small gap beyond the window's candles, centred on the window and kept inside the pane; the leader joins that gap to the chip's edge", () => {
    const inside = { pivotTs: T + 300_000, frozenTs: T + 480_000, legExtremeTs: T + 540_000, updatedAt: T + 600_000 };
    const [mark] = layoutInitiative([band(inside)], geometry, 0.6);
    expect(mark.chip).toEqual({ left: 420 - CHIP_WIDTH / 2, top: 302 + LEADER_GAP + LEADER_LENGTH, width: CHIP_WIDTH, height: CHIP.height, title: CHIP_TITLE, value: "4/5", detail: "buyers", leader: { from: { x: 420, y: 302 + LEADER_GAP }, to: { x: 420, y: 302 + LEADER_GAP + LEADER_LENGTH } } });
    const [fall] = layoutInitiative([band({ ...inside, side: "down", dominant: "sellers", pivotPrice: 210, frozenPrice: 198, legExtremePrice: 194 })], geometry, 0.6);
    expect(fall.chip).toMatchObject({ top: 290 - LEADER_GAP - LEADER_LENGTH - CHIP.height, detail: "sellers", leader: { from: { x: 420, y: 290 - LEADER_GAP }, to: { x: 420, y: 290 - LEADER_GAP - LEADER_LENGTH } } });
    const [clamped] = layoutInitiative([band()], geometry, 0.6);
    expect(clamped.chip!.left).toBe(CHIP_EDGE);
    expect(clamped.chip!.leader.to.x).toBe(CHIP_EDGE + CHIP.radius);
    const [edge] = layoutInitiative([band({ pivotTs: T + 900_000, frozenTs: T + 1_080_000, legExtremeTs: T + 1_100_000, updatedAt: T + 1_160_000 })], geometry, 0.6);
    expect(edge.chip!.left).toBe(1000 - CHIP_WIDTH - CHIP_EDGE);
    expect(edge.chip!.leader.to.x).toBe(edge.chip!.left + edge.chip!.width - CHIP.radius);
    expect([CHIP_WIDTH, chipTextWidth("4/5", 12), LEADER_LENGTH, LEADER_WIDTH, CHIP_EDGE, CHIP_GAP]).toEqual([CHIP.padX * 2 + Math.max(chipTextWidth(CHIP_TITLE, 9) + CHIP.arrowGap + CHIP.arrowWidth, chipTextWidth("4/5", 12) + CHIP.detailGap + chipTextWidth("buyers", 9)), 23, 26, 1, 4, 4]);
    expect(chipWidthOf({ title: CHIP_TITLE, value: "4/5", detail: "sellers" })).toBe(CHIP.padX * 2 + chipTextWidth("4/5", 12) + CHIP.detailGap + chipTextWidth("sellers", 9));
    expect(chipWidthOf({ title: "X", value: "4/5", detail: "sellers" })).toBe(CHIP.padX * 2 + chipTextWidth("4/5", 12) + CHIP.detailGap + chipTextWidth("sellers", 9));
  });

  it("two chips that would touch are stacked away from the candles, the later one further out; the shade and the chip can each be hidden", () => {
    const twin = band({ id: "twin", pivotTs: T - 120_000, pivotPrice: 199, frozenTs: T + 60_000, legExtremeTs: T + 120_000, updatedAt: T + 180_000 });
    const [first, second] = layoutInitiative([band(), twin], geometry, 0.6);
    expect(second.chip!.top).toBe(first.chip!.top + CHIP.height + CHIP_GAP);
    expect(second.chip!.leader.to.y).toBe(second.chip!.top);
    const [fallFirst, fallSecond] = layoutInitiative([band({ side: "down", pivotPrice: 210, frozenPrice: 198 }), band({ ...twin, side: "down", pivotPrice: 211, frozenPrice: 199 })], geometry, 0.6);
    expect(fallSecond.chip!.top).toBe(fallFirst.chip!.top - CHIP.height - CHIP_GAP);
    expect(fallSecond.chip!.leader.to.y).toBe(fallSecond.chip!.top + CHIP.height);
    const [noChip] = layoutInitiative([band()], geometry, 0.6, null, true, false);
    expect([noChip.chip, noChip.showShade]).toEqual([null, true]);
    const [noShade] = layoutInitiative([band()], geometry, 0.6, null, false, true);
    expect(noShade.showShade).toBe(false);
    expect(noShade.chip).not.toBeNull();
  });

  it("a band off the pane or before the chart's reach is left out; one touching the pane's edge stays; the hovered one is marked", () => {
    expect(layoutInitiative([band({ pivotTs: T - 900_000 })], geometry, 0.6)).toEqual([]);
    expect(layoutInitiative([band({ pivotPrice: 1100, frozenPrice: 1200 })], geometry, 0.6)).toEqual([]);
    expect(layoutInitiative([band({ pivotPrice: 700, frozenPrice: 720 })], geometry, 0.6)).toEqual([]);
    expect(layoutInitiative([band({ pivotPrice: 520, frozenPrice: 530 })], geometry, 0.6)).toEqual([]);
    expect(layoutInitiative([band({ pivotPrice: 499, frozenPrice: 501 })], geometry, 0.6)).toHaveLength(1);
    expect(layoutInitiative([band({ pivotPrice: 500, frozenPrice: 502 })], geometry, 0.6)).toHaveLength(1);
    expect(layoutInitiative([band({ pivotPrice: -2, frozenPrice: 0 })], geometry, 0.6)).toHaveLength(1);
    expect(layoutInitiative([band({ pivotPrice: -1, frozenPrice: 1 })], geometry, 0.6)).toHaveLength(1);
    expect(layoutInitiative([band({ pivotPrice: -40, frozenPrice: -30 })], geometry, 0.6)).toEqual([]);
    expect(layoutInitiative([band({ pivotTs: T - 600_000, frozenTs: T - 480_000, legExtremeTs: T - 420_000, updatedAt: T - 400_000 })], geometry, 0.6)).toEqual([]);
    expect(layoutInitiative([band({ pivotTs: T + 1_500_000, frozenTs: T + 1_680_000, legExtremeTs: T + 1_680_000, updatedAt: T + 1_740_000 })], geometry, 0.6)).toEqual([]);
    expect(layoutInitiative([band()], geometry, 0.6, "b")[0].hovered).toBe(true);
    expect(layoutInitiative([band()], geometry, 0.6, "other")[0].hovered).toBe(false);
  });
});

describe("drawInitiativeShades", () => {
  const mark = (over: Partial<InitiativeMark> = {}): InitiativeMark => ({ ...layoutInitiative([band()], geometry, 0.6)[0], ...over });

  it("a band's shade is one fill over the window only, clear at its top and bottom edges and at the opacity's share through its middle, the fade inside the window; brighter when hovered, in the leg's colour whatever the flow, nothing when hidden", () => {
    const { context, ops, gradients } = recordingContext();
    drawInitiativeShades(context, [mark()], DEFAULT_INITIATIVE_SETTINGS);
    expect(ops.map((op) => op.op)).toEqual(["createLinearGradient", "fillRect"]);
    expect(gradients[0].args).toEqual([0, 290, 0, 302]);
    const core = css(buyers, 0.6 * SHADE_CORE);
    expect(gradients[0].stops).toEqual([[0, css(buyers, 0)], [0.5, core], [0.5, core], [1, css(buyers, 0)]]);
    expect(ops[1].args).toEqual([-180, 290, 240, 12]);
    expect(ops[1].fillStyle).toBe(gradients[0]);
    const tall = recordingContext();
    drawInitiativeShades(tall.context, layoutInitiative([band({ pivotPrice: 100, frozenPrice: 300, legExtremePrice: 320 })], geometry, 0.6), DEFAULT_INITIATIVE_SETTINGS);
    expect(tall.gradients[0].args).toEqual([0, 200, 0, 400]);
    expect(tall.gradients[0].stops.map(([offset]) => offset)).toEqual([0, 0.2, 0.8, 1]);
    expect(tall.ops[1].args).toEqual([-180, 200, 240, 200]);
    const flat = recordingContext();
    drawInitiativeShades(flat.context, layoutInitiative([band({ frozenPrice: 198 })], geometry, 0.6), DEFAULT_INITIATIVE_SETTINGS);
    expect(flat.gradients[0].stops.map(([offset]) => offset)).toEqual([0, 0, 1, 1]);
    expect(flat.ops[1].args).toEqual([-180, 302, 240, 1]);
    const hovered = recordingContext();
    drawInitiativeShades(hovered.context, [mark({ hovered: true })], DEFAULT_INITIATIVE_SETTINGS);
    expect(hovered.gradients[0].stops[1][1]).toBe(css(buyers, 0.6 * SHADE_CORE * SHADE_HOVER_BOOST));
    const onSellers = recordingContext();
    drawInitiativeShades(onSellers.context, [mark({ band: band({ side: "down", dominant: "buyers" }) })], DEFAULT_INITIATIVE_SETTINGS);
    expect(onSellers.gradients[0].stops[2][1]).toBe(css(sellers, 0.6 * SHADE_CORE));
    const upOnSellers = recordingContext();
    drawInitiativeShades(upOnSellers.context, [mark({ band: band({ side: "up", dominant: "sellers" }) })], DEFAULT_INITIATIVE_SETTINGS);
    expect(upOnSellers.gradients[0].stops[2][1]).toBe(css(buyers, 0.6 * SHADE_CORE));
    const chosen = recordingContext();
    drawInitiativeShades(chosen.context, [mark()], { ...DEFAULT_INITIATIVE_SETTINGS, buyerColor: "#123456" });
    expect(chosen.gradients[0].stops[1][1]).toBe(css(parseRgb("#123456", "#000000"), 0.6 * SHADE_CORE));
    const hidden = recordingContext();
    drawInitiativeShades(hidden.context, [mark({ showShade: false })], DEFAULT_INITIATIVE_SETTINGS);
    expect(hidden.ops).toEqual([]);
  });
});

describe("drawInitiativeMarks", () => {
  const mark = (over: Partial<InitiativeMark> = {}): InitiativeMark => ({ ...layoutInitiative([band()], geometry, 0.6)[0], ...over });
  const kinds = (ops: Op[]) => ops.map((op) => op.op);
  const LEADER = ["beginPath", "moveTo", "lineTo", "stroke"];
  const CHIP_OPS = ["beginPath", "moveTo", "arcTo", "arcTo", "arcTo", "arcTo", "closePath", "fill", "stroke", "fillText", "beginPath", "moveTo", "lineTo", "lineTo", "closePath", "fill", "fillText", "fillText"];

  it("a band's chip is its leader at the opacity's alpha, then the card: dark fill, the colour's rim, the title with the side's arrow, the score and the pushing side", () => {
    const m = mark();
    const { context, ops } = recordingContext();
    drawInitiativeMarks(context, [m], DEFAULT_INITIATIVE_SETTINGS);
    expect(kinds(ops)).toEqual([...LEADER, ...CHIP_OPS]);
    expect(ops[1].args).toEqual([m.chip!.leader.from.x, m.chip!.leader.from.y]);
    expect(ops[2].args).toEqual([m.chip!.leader.to.x, m.chip!.leader.to.y]);
    expect(ops[3]).toMatchObject({ strokeStyle: css(buyers, 0.6), lineWidth: LEADER_WIDTH });
    const chip = ops.slice(4);
    expect(chip[1].args).toEqual([m.chip!.left + CHIP.radius, m.chip!.top]);
    expect(chip[7].fillStyle).toBe(CHIP_FILL);
    expect(chip[8]).toMatchObject({ strokeStyle: css(buyers, CHIP_RIM_ALPHA), lineWidth: 1 });
    expect(chip[9]).toMatchObject({ args: [CHIP_TITLE, m.chip!.left + CHIP.padX, m.chip!.top + CHIP.titleBaseline], fillStyle: CHIP_TITLE_INK, font: CHIP_TITLE_FONT });
    const arrowX = m.chip!.left + CHIP.padX + chipTextWidth(CHIP_TITLE, CHIP.titlePx) + CHIP.arrowGap + CHIP.arrowWidth / 2;
    expect(chip[11].args).toEqual([arrowX, m.chip!.top + CHIP.arrowMid - CHIP.arrowHeight / 2]);
    expect(chip[15].fillStyle).toBe(css(buyers, 1));
    expect(chip[16]).toMatchObject({ args: ["4/5", m.chip!.left + CHIP.padX, m.chip!.top + CHIP.valueBaseline], fillStyle: CHIP_VALUE_INK, font: CHIP_VALUE_FONT });
    expect(chip[17]).toMatchObject({ args: ["buyers", m.chip!.left + CHIP.padX + chipTextWidth("4/5", CHIP.valuePx) + CHIP.detailGap, m.chip!.top + CHIP.valueBaseline], fillStyle: CHIP_DETAIL_INK, font: CHIP_DETAIL_FONT });
    expect([CHIP_FILL, CHIP_RIM_ALPHA]).toEqual(["rgba(15, 17, 26, 0.92)", 0.55]);
  });

  it("a down leg's chip arrow points down and its leader, rim and word are the sellers' whatever the flow; without the chip nothing is drawn on top; the hovered band's chip gets a full rim", () => {
    const { context, ops } = recordingContext();
    const [downMark] = layoutInitiative([band({ side: "down", dominant: "buyers" })], geometry, 0.6);
    expect(downMark.chip!.detail).toBe("sellers");
    drawInitiativeMarks(context, [downMark], DEFAULT_INITIATIVE_SETTINGS);
    expect(ops.filter((op) => op.op === "fillText").map((op) => op.args[0])).toEqual([CHIP_TITLE, "4/5", "sellers"]);
    const arrow = ops.slice(4 + 10, 4 + 16);
    expect(arrow.map((op) => op.op)).toEqual(["beginPath", "moveTo", "lineTo", "lineTo", "closePath", "fill"]);
    expect((arrow[1].args as number[])[1]).toBe(downMark.chip!.top + CHIP.arrowMid + CHIP.arrowHeight / 2);
    expect(ops[3].strokeStyle).toBe(css(sellers, 0.6));
    expect(ops[4 + 8].strokeStyle).toBe(css(sellers, CHIP_RIM_ALPHA));
    const none = recordingContext();
    drawInitiativeMarks(none.context, [mark({ chip: null })], DEFAULT_INITIATIVE_SETTINGS);
    expect(none.ops).toEqual([]);
    const hovered = recordingContext();
    drawInitiativeMarks(hovered.context, [mark({ hovered: true })], DEFAULT_INITIATIVE_SETTINGS);
    expect(hovered.ops[4 + 8]).toMatchObject({ strokeStyle: css(buyers, 1), lineWidth: 1 });
  });
});

describe("markHit", () => {
  it("answers inside the shade and inside the chip, the chip first; a hidden shade does not answer, nor a missing chip, nor the leader", () => {
    const [m] = layoutInitiative([band()], geometry, 0.6);
    expect(CHIP_HIT_SLACK).toBe(2);
    expect(markHit({ x: -60, y: 296 }, m)).toBe("shade");
    expect(markHit({ x: -60, y: 302 }, m)).toBe("shade");
    expect(markHit({ x: -60, y: 303 }, m)).toBeNull();
    expect(markHit({ x: -60, y: 290 }, m)).toBe("shade");
    expect(markHit({ x: -60, y: 289 }, m)).toBeNull();
    expect(markHit({ x: -180, y: 296 }, m)).toBe("shade");
    expect(markHit({ x: -181, y: 296 }, m)).toBeNull();
    expect(markHit({ x: 60, y: 296 }, m)).toBe("shade");
    expect(markHit({ x: 61, y: 296 }, m)).toBeNull();
    expect(markHit({ x: m.chip!.left + 1, y: m.chip!.top + 1 }, m)).toBe("chip");
    expect(markHit({ x: m.chip!.left - CHIP_HIT_SLACK - 1, y: m.chip!.top + 1 }, m)).toBeNull();
    expect(markHit({ x: -60, y: 296 }, { ...m, showShade: false })).toBeNull();
    expect(markHit({ x: m.chip!.left + 1, y: m.chip!.top + 1 }, { ...m, chip: null })).toBeNull();
    const inside = layoutInitiative([band({ pivotTs: T + 300_000, frozenTs: T + 480_000, legExtremeTs: T + 540_000, updatedAt: T + 600_000 })], geometry, 0.6)[0];
    expect(markHit({ x: 420, y: (inside.chip!.leader.from.y + inside.chip!.leader.to.y) / 2 + 3 }, { ...inside, showShade: false })).toBeNull();
    expect(insideShade({ x: 0, y: 0 }, { left: 0, right: 10, top: 0, bottom: 10, fade: 5 })).toBe(true);
    expect(insideShade({ x: 0, y: 11 }, { left: 0, right: 10, top: 0, bottom: 10, fade: 5 })).toBe(false);
    expect(insideChip({ x: 5, y: 5 }, { left: 0, top: 0, width: 10, height: 10 })).toBe(true);
    expect(insideChip({ x: 11, y: 5 }, { left: 0, top: 0, width: 10, height: 10 })).toBe(false);
  });
});

describe("initiativeStatusText", () => {
  it("says when the runtime has not answered, when the book is untrusted and what span of history is loading; nothing otherwise", () => {
    const book = new InitiativeBook();
    expect(initiativeStatusText(null)).toBe("INITIATIVE · WAITING FOR THE RUNTIME");
    expect(initiativeStatusText(book)).toBe("INITIATIVE · UNTRUSTED UNTIL THE NEXT PAGE");
    book.apply(frameOf([]));
    expect(initiativeStatusText(book)).toBeNull();
    book.apply(frameOf([], { seq: 1, ts: T + 1, loading: T - 3 * 86_400_000 }));
    expect(initiativeStatusText(book)).toBe("INITIATIVE · LOADING 3 DAYS");
    book.markUntrusted();
    expect(initiativeStatusText(book)).toBe("INITIATIVE · UNTRUSTED UNTIL THE NEXT PAGE");
    book.apply(frameOf([], { seq: 2, ts: T + 2, loading: null }));
    expect(initiativeStatusText(book)).toBeNull();
    expect(STATUS_BADGE_SLOT.initiative).toBe(9);
  });
});

function frameOf(bands: InitiativeBand[], over: Partial<InitiativeBandsFrame> = {}): InitiativeBandsFrame {
  const base: InitiativeBandsFrame = { type: "initiative_bands", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL", ts: T, seq: 0, reset: true, bands, liveSince: T - 3_600_000, loading: null };
  return { ...base, ...over } as InitiativeBandsFrame;
}

function fakeChart(bars: readonly CandlestickData<UTCTimestamp>[], scale = 1) {
  const calls: string[] = [];
  const chart = {
    timeScale: () => ({ width: () => 2000, options: () => ({ barSpacing: 60 * scale }), timeToCoordinate: (time: number) => (time - bars[0].time) * scale }),
    paneSize: () => ({ height: 500 }),
  };
  const series = { data: () => bars, priceToCoordinate: (price: number) => 500 - price };
  return { chart, series, calls, attach: (primitive: InitiativePrimitive) => primitive.attached({ chart, series, requestUpdate: () => calls.push("update") } as never) };
}

describe("InitiativePrimitive", () => {
  const bars: CandlestickData<UTCTimestamp>[] = Array.from({ length: 40 }, (_, i) => ({ time: ((T - 20 * 60_000) / 1000 + i * 60) as UTCTimestamp, open: 200, high: 201, low: 199, close: 200 }));

  it("reads the chart's candles between two times by their open", () => {
    expect(candlesBetween(bars, T - 180_000, T).map((c) => c.ts)).toEqual([T - 180_000, T - 120_000, T - 60_000, T]);
    expect(candlesBetween(bars, T + 1, T + 60_000)).toEqual([{ ts: T + 60_000, high: 201, low: 199 }]);
    expect(candlesBetween(bars, T + 10_000_000, T + 20_000_000)).toEqual([]);
    expect(candlesBetween([], T, T)).toEqual([]);
  });

  it("draws the book's bands of the chart's candle length through the settings' filter, the shades behind the candles and the chips above them, answers hover over a mark, and empties when the book or the candle goes", () => {
    const now = { at: T + 30_000 };
    const primitive = new InitiativePrimitive(() => bars, () => now.at);
    const fake = fakeChart(bars);
    fake.attach(primitive);
    const book = new InitiativeBook();
    book.apply(frameOf([band(), band({ id: "5m", candleMs: 300000, pivotTs: T - 900_000 })]));
    primitive.setCandleMs(60_000);
    primitive.setShown(true);
    primitive.setBook(book);
    primitive.updateAllViews();
    expect(primitive.marks.map((mark) => mark.band.id)).toEqual(["b"]);
    const [mark] = primitive.marks;
    expect(mark.shade).toEqual({ left: 990, right: 1230, top: 290, bottom: 302, fade: 6 });
    expect(primitive.boxAt(1110, 296)?.title).toBe("▲ BUY START · STRONG (4 of 5)");
    expect(primitive.boxAt(mark.chip!.left + 2, mark.chip!.top + 2)?.short).toBe("Buy start · Strong (4 of 5)");
    expect(primitive.boxAt(1110, 260)).toBeNull();
    expect(primitive.paneViews().map((view) => view.zOrder?.())).toEqual(["bottom", "top", "top"]);
    const draw = (index: number) => {
      const into = recordingContext();
      primitive.paneViews()[index].renderer()!.draw({ useMediaCoordinateSpace: (paint: (scope: { context: unknown }) => void) => paint({ context: into.context }) } as never);
      return into;
    };
    expect(draw(0).ops.map((op) => op.op)).toEqual(["createLinearGradient", "fillRect"]);
    expect(draw(1).ops.filter((op) => op.op === "fillText").map((op) => op.args[0])).toEqual([CHIP_TITLE, "4/5", "buyers"]);
    expect(draw(1).ops.filter((op) => op.op === "fillRect")).toHaveLength(0);
    primitive.setSettings({ ...DEFAULT_INITIATIVE_SETTINGS, showLabels: false });
    primitive.updateAllViews();
    expect(primitive.marks[0].chip).toBeNull();
    primitive.setSettings({ ...DEFAULT_INITIATIVE_SETTINGS, showShade: false });
    primitive.updateAllViews();
    expect(primitive.marks[0].showShade).toBe(false);
    expect(primitive.boxAt(1110, 296)).toBeNull();
    primitive.setSettings(DEFAULT_INITIATIVE_SETTINGS);
    primitive.setHover("b");
    primitive.updateAllViews();
    expect(primitive.marks[0].hovered).toBe(true);
    primitive.setHover(null);
    primitive.updateAllViews();
    expect(primitive.marks[0].hovered).toBe(false);
    primitive.setShown(false);
    primitive.updateAllViews();
    expect(primitive.marks).toEqual([]);
    expect(draw(0).ops).toEqual([]);
    expect(draw(1).ops).toEqual([]);
    primitive.setShown(true);
    primitive.updateAllViews();
    expect(primitive.marks).toHaveLength(1);
    primitive.setCandleMs(300_000);
    primitive.updateAllViews();
    expect(primitive.marks.map((mark) => mark.band.id)).toEqual(["5m"]);
    primitive.setBook(null);
    primitive.updateAllViews();
    expect(primitive.marks).toEqual([]);
    expect(primitive.shown).toBe(true);
    primitive.setShown(false);
    primitive.updateAllViews();
    expect(primitive.shown).toBe(false);
    primitive.detached();
    expect(primitive.marks).toEqual([]);
  });

  it("where shades overlap, the smaller answers the cursor, and a chip beats a shade", () => {
    const now = { at: T + 120_000 };
    const primitive = new InitiativePrimitive(() => bars, () => now.at);
    fakeChart(bars, 0.5).attach(primitive);
    const book = new InitiativeBook();
    book.apply(frameOf([band({ id: "big", pivotTs: T - 600_000, pivotPrice: 160, frozenPrice: 212, windowCandles: 10 }), band({ id: "small", pivotTs: T - 120_000, pivotPrice: 200, frozenPrice: 206, windowCandles: 2 })]));
    primitive.setCandleMs(60_000);
    primitive.setShown(true);
    primitive.setBook(book);
    primitive.updateAllViews();
    const big = primitive.marks.find((m) => m.band.id === "big")!;
    const small = primitive.marks.find((m) => m.band.id === "small")!;
    expect(big.shade).toEqual({ left: 285, right: 615, top: 288, bottom: 340, fade: 26 });
    expect(small.shade).toEqual({ left: 525, right: 615, top: 294, bottom: 301, fade: 3.5 });
    expect(shadeArea(small.shade)).toBeLessThan(shadeArea(big.shade));
    expect(markHit({ x: 570, y: 297 }, big)).toBe("shade");
    expect(primitive.boxAt(570, 297)?.id).toBe("small");
    expect(primitive.boxAt(287, 300)?.id).toBe("big");
    expect(primitive.boxAt(big.chip!.left + 2, big.chip!.top + 2)?.id).toBe("big");
    expect(markHit({ x: small.chip!.left + 2, y: small.chip!.top + 2 }, big)).toBe("shade");
    expect(primitive.boxAt(small.chip!.left + 2, small.chip!.top + 2)?.id).toBe("small");
    primitive.detached();
  });

  it("asks the chart to repaint on a change and filters the book once per book version, settings object, candle length and minute", async () => {
    const now = { at: T + 30_000 };
    const primitive = new InitiativePrimitive(() => bars, () => now.at);
    const fake = fakeChart(bars);
    fake.attach(primitive);
    const book = new InitiativeBook();
    book.apply(frameOf([band()]));
    const list = vi.spyOn(book, "list");
    primitive.setCandleMs(60_000);
    primitive.setShown(true);
    primitive.setBook(book);
    primitive.updateAllViews();
    primitive.updateAllViews();
    expect(list).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fake.calls.length).toBeGreaterThan(0);
    book.apply(frameOf([band({ id: "t", score: 5, pivotTs: T - 240_000, frozenTs: T - 180_000, legExtremeTs: T - 120_000, updatedAt: T })], { reset: false, seq: 1 }));
    primitive.refresh();
    primitive.updateAllViews();
    expect(list).toHaveBeenCalledTimes(2);
    expect(primitive.marks.map((mark) => mark.band.id)).toEqual(["t", "b"]);
    const stricter = { ...DEFAULT_INITIATIVE_SETTINGS, minScore: 5 };
    primitive.setSettings(stricter);
    primitive.updateAllViews();
    expect(list).toHaveBeenCalledTimes(3);
    expect(primitive.marks.map((mark) => mark.band.id)).toEqual(["t"]);
    primitive.setSettings(stricter);
    primitive.updateAllViews();
    expect(list).toHaveBeenCalledTimes(3);
    now.at += 60_000;
    primitive.updateAllViews();
    expect(list).toHaveBeenCalledTimes(4);
    primitive.detached();
  });
});
