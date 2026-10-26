import { describe, expect, it } from "vitest";
import type { IcebergOrder, IcebergOrdersFrame } from "../../../../types/frames";
import { IcebergBook } from "../../../l2/icebergBook";
import { STATUS_BADGE_SLOT } from "../../../chart/statusBadge";
import {
  ICEBERG_CARD,
  ICEBERG_CARD_FILL,
  ICEBERG_CARD_FILL_ON_DARK,
  ICEBERG_CARD_GAP_PX,
  ICEBERG_CARD_TITLE,
  ICEBERG_CHAR_EM,
  ICEBERG_DETAIL_FONT,
  ICEBERG_DOT_CLEARANCE_PX,
  ICEBERG_DOT_MAX_PX,
  ICEBERG_DOT_MIN_PX,
  ICEBERG_LINE_VISIBLE_PX,
  ICEBERG_EDGE_PX,
  ICEBERG_LINE_PX,
  ICEBERG_MAX_CARDS,
  ICEBERG_RING_CENTER,
  ICEBERG_RING_CENTER_ON_DARK,
  ICEBERG_TITLE_FONT,
  ICEBERG_VALUE_FONT,
  IcebergPrimitive,
  icebergCardWidth,
  icebergMarkAt,
  icebergMarkRadius,
  icebergSizeReference,
  icebergStatusText,
  layoutIcebergs,
  traceArrow,
  traceTriangle,
  type IcebergCard,
  type IcebergMark,
  type IcebergSlot,
} from "../icebergPrimitive";

const H1 = 3_600_000;
const HALF = 1_800_000;
const C = Math.floor(Date.now() / H1) * H1 - 4 * H1;
const BID_SETTLED = "rgba(14, 154, 102, 0.800)";
const BID_SOLID = "rgba(14, 154, 102, 1.000)";
const ASK_SOLID = "rgba(124, 58, 237, 1.000)";
const ASK_SETTLED = "rgba(124, 58, 237, 0.800)";

function iceberg(overrides: Partial<IcebergOrder> = {}): IcebergOrder {
  return {
    id: "a", kind: "native", confidence: "certain", origin: "runtime", side: "bid", price: 2600, display: 10, tranches: 3, executed: 32,
    startedAt: C + 500_000, markedAt: C + 600_000, updatedAt: C + 700_000, status: "filled", ...overrides,
  };
}

function page(icebergs: IcebergOrder[], seq = 0, reset = true): IcebergOrdersFrame {
  return { type: "iceberg_orders", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "PERPETUAL", ts: C + H1, seq, reset, icebergs, watched: [], liveSince: C };
}

interface Op {
  op: string;
  args: unknown[];
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: unknown;
  font: unknown;
  textAlign: unknown;
  textBaseline: unknown;
  dash: number[];
}

function recordingContext() {
  const ops: Op[] = [];
  let dash: number[] = [];
  const context: Record<string, unknown> = {
    fillStyle: "", strokeStyle: "", lineWidth: 0, font: "", textAlign: "start", textBaseline: "alphabetic",
    save() {}, restore() {},
    setLineDash(next: number[]) { dash = [...next]; },
  };
  for (const op of ["beginPath", "closePath", "moveTo", "lineTo", "arc", "arcTo", "fill", "stroke", "fillText", "fillRect"]) {
    context[op] = (...args: unknown[]) => {
      ops.push({ op, args, fillStyle: context.fillStyle, strokeStyle: context.strokeStyle, lineWidth: context.lineWidth, font: context.font, textAlign: context.textAlign, textBaseline: context.textBaseline, dash: [...dash] });
    };
  }
  return { context, ops };
}

function drawn(primitive: IcebergPrimitive): Op[] {
  const { context, ops } = recordingContext();
  primitive.paneViews()[0].renderer()!.draw({ useMediaCoordinateSpace: (paint: (scope: unknown) => void) => paint({ context }) } as never);
  return ops;
}

function mounted(icebergs: IcebergOrder[], settings: Parameters<IcebergPrimitive["setSettings"]>[0] = { historyDays: 5 }) {
  const book = new IcebergBook();
  book.apply(page(icebergs));
  const primitive = new IcebergPrimitive(null, () => C + H1);
  const counts = { price: 0 };
  const live = { time: C / 1000 + 1_800, open: 2600, high: 2605, low: 2595, close: 2600 };
  const world = { primitive, priceShift: 0, timeShift: 0, width: 1000, height: 500, bars: [{ time: C / 1000, open: 2600, high: 2605, low: 2595, close: 2600 }, live] };
  const timeScale = {
    timeToCoordinate: (time: number) => {
      const index = world.bars.findIndex((bar) => bar.time === time);
      return index < 0 ? null : 490 + index * 10 + world.timeShift;
    },
    width: () => world.width,
  };
  const chart = { timeScale: () => timeScale, paneSize: () => ({ height: world.height }) };
  const series = {
    data: () => world.bars,
    priceToCoordinate: (price: number) => {
      counts.price += 1;
      return 500 - price / 10 + world.priceShift;
    },
  };
  primitive.attached({ chart, series, requestUpdate: () => {} } as unknown as Parameters<IcebergPrimitive["attached"]>[0]);
  primitive.setBook(book);
  primitive.setShown(true);
  primitive.setSettings({ minTranches: 1, ...settings });
  primitive.setUnit("BTC");
  primitive.updateAllViews();
  return { primitive, book, counts, live, world };
}

const PANE = { width: 1000, height: 600 };
const textWidth = (text: string, px: number) => text.length * px * ICEBERG_CHAR_EM;

function touch(a: IcebergCard, b: IcebergCard): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

function at(id: string, marks: readonly IcebergMark[]): IcebergMark {
  return marks.find((mark) => mark.iceberg.id === id)!;
}

const LONE_PX = icebergMarkRadius(40, icebergSizeReference([40]), 1);

describe("iceberg marks", () => {
  it("a card is sized from its text at the monospace advance, the title row setting the floor", () => {
    expect(icebergCardWidth("40", "(10 × 4)")).toBe(79);
    expect(icebergCardWidth("15.8", "(5.27 × 3)")).toBe(105);
    expect(icebergCardWidth("7", "")).toBe(66);
    expect(ICEBERG_CARD_TITLE).toBe("ICEBERG");
  });

  it("the arrow points up on a bid and down on an ask: a head and a shaft around its centre", () => {
    const { context, ops } = recordingContext();
    traceArrow(context as never, 100, 200, "bid");
    traceArrow(context as never, 100, 200, "ask");
    const points = ops.filter((op) => op.op === "moveTo" || op.op === "lineTo").map((op) => op.args);
    expect(points.slice(0, 7)).toEqual([[100, 195.5], [103.5, 199.5], [101, 199.5], [101, 204.5], [99, 204.5], [99, 199.5], [96.5, 199.5]]);
    expect(points.slice(7)).toEqual([[100, 204.5], [103.5, 200.5], [101, 200.5], [101, 195.5], [99, 195.5], [99, 200.5], [96.5, 200.5]]);
  });

  it("a buy iceberg's line runs straight down from the point of contact to a card below it, a sell's straight up to a card above", () => {
    const geometry = { xOf: () => 300, yOf: () => 250, ...PANE };
    const [buy] = layoutIcebergs([iceberg()], {}, geometry, () => 1000);
    expect(buy).toMatchObject({ x: 300, y: 250, r: LONE_PX, shape: "dot", lineEnd: 250 + ICEBERG_LINE_PX, hollow: false, dashed: false, alpha: 0.8, slot: { down: true, anchor: 0, length: ICEBERG_LINE_PX } });
    expect(buy.card).toEqual({ left: 260.5, top: 250 + ICEBERG_LINE_PX, width: 79, height: ICEBERG_CARD.height, total: "40", breakdown: "(10 × 4)" });
    const [sell] = layoutIcebergs([iceberg({ side: "ask", kind: "probable", confidence: "strong", origin: "runtime", status: "active", executed: 8.939, display: 5.266, tranches: 3 })], { markScale: 2 }, geometry, () => 1000);
    expect(sell).toMatchObject({ x: 300, y: 250, r: icebergMarkRadius(1, icebergSizeReference([1]), 2), shape: "circle", lineEnd: 250 - ICEBERG_LINE_PX, hollow: true, alpha: 1 });
    expect(sell.card).toMatchObject({ top: 250 - ICEBERG_LINE_PX - ICEBERG_CARD.height, width: 105, total: "10.5", breakdown: "(5.27 × 2)" });
  });

  it("layout puts the point on the candle that holds markedAt, at the iceberg's price, and skips what has no candle or a point off the pane", () => {
    const geometry = { xOf: (ms: number) => (ms === 1000 ? 50 : null), yOf: (price: number) => (price === 2600 ? 120 : price === 1 ? -3 : price === 2 ? 601 : null), ...PANE };
    const columnOf = (ts: number) => (ts < 2000 ? 1000 : null);
    const marks = layoutIcebergs([
      iceberg({ markedAt: 1500 }),
      iceberg({ id: "late", markedAt: 5000 }),
      iceberg({ id: "nopx", markedAt: 1500, price: 3 }),
      iceberg({ id: "above", markedAt: 1500, price: 1 }),
      iceberg({ id: "below", markedAt: 1500, price: 2 }),
    ], {}, geometry, columnOf);
    expect(marks.map((mark) => [mark.iceberg.id, mark.x, mark.y])).toEqual([["a", 50, 120]]);
    expect(layoutIcebergs([iceberg()], {}, { xOf: () => -1, yOf: () => 120, ...PANE }, () => 1000)).toEqual([]);
    expect(layoutIcebergs([iceberg()], {}, { xOf: () => 1001, yOf: () => 120, ...PANE }, () => 1000)).toEqual([]);
  });

  it("of two close sells the newer keeps the plain line, and the older takes the nearest clean slot on the same side, sideways and shorter, never below", () => {
    const geometry = { xOf: (ms: number) => ms, yOf: () => 250, ...PANE };
    const marks = layoutIcebergs([iceberg({ id: "a", side: "ask", markedAt: 300 }), iceberg({ id: "b", side: "ask", markedAt: 330 })], {}, geometry, (ts) => ts);
    expect(at("b", marks)).toMatchObject({ lineEnd: 150, slot: { down: false, anchor: 0, length: 100 }, card: { left: 290.5, top: 114 } });
    expect(at("a", marks)).toMatchObject({ lineEnd: 190, slot: { down: false, anchor: -1, length: 60 }, card: { left: 233, top: 154 } });
    expect(touch(at("a", marks).card!, at("b", marks).card!)).toBe(false);
    const walled = layoutIcebergs([iceberg({ id: "a", side: "ask", markedAt: 300 }), iceberg({ id: "b", side: "ask", markedAt: 330 })], {}, { ...geometry, height: 300 }, (ts) => ts);
    expect(walled.map((mark) => [mark.iceberg.id, mark.lineEnd, mark.card!.left])).toEqual(marks.map((mark) => [mark.iceberg.id, mark.lineEnd, mark.card!.left]));
  });

  it("a line never runs through another mark's point: a big sell under a small one on the same candle keeps only its point, since a sell's card never goes below", () => {
    const geometry = { xOf: () => 300, yOf: (price: number) => price, ...PANE };
    const marks = layoutIcebergs([
      iceberg({ id: "small", side: "ask", price: 200 }),
      iceberg({ id: "big", side: "ask", price: 250, display: 2, tranches: 80, executed: 160 }),
    ], {}, geometry, () => 1000);
    expect(at("big", marks)).toMatchObject({ card: null, lineEnd: null, slot: null });
    expect(at("small", marks)).toMatchObject({ lineEnd: 100, slot: { down: false, length: 100 } });
  });

  it("cards keep a gap between them: a sell whose plain slot would sit two pixels from a neighbour's card goes elsewhere", () => {
    const geometry = { xOf: (ms: number) => ms, yOf: () => 250, ...PANE };
    const marks = layoutIcebergs([iceberg({ id: "a", side: "ask", markedAt: 300 }), iceberg({ id: "b", side: "ask", markedAt: 381 })], {}, geometry, (ts) => ts);
    expect(at("b", marks)).toMatchObject({ lineEnd: 150, card: { left: 341.5 } });
    expect(at("a", marks)).toMatchObject({ lineEnd: 110, slot: { down: false, length: 140 }, card: { left: 260.5, top: 74 } });
  });

  it("the live candle at the right edge still gets a card, flush with the edge so the line lands on its flat side; past the edge there is none", () => {
    const edge = layoutIcebergs([iceberg({ side: "ask" })], {}, { xOf: () => 997, yOf: () => 250, ...PANE }, () => 1000);
    expect(edge[0].card).toMatchObject({ left: 1000 - 79, top: 114 });
    const beyond = layoutIcebergs([iceberg({ side: "ask" })], {}, { xOf: () => 999.5, yOf: () => 250, ...PANE }, () => 1000);
    expect(beyond[0].card).toBeNull();
    const [inset] = layoutIcebergs([iceberg({ side: "ask" })], {}, { xOf: () => 997, yOf: () => 250, cardRight: 900, ...PANE }, () => 1000);
    expect(inset.card).toBeNull();
    const [room] = layoutIcebergs([iceberg({ side: "ask" })], {}, { xOf: () => 880, yOf: () => 250, cardRight: 900, ...PANE }, () => 1000);
    expect(room.card).toMatchObject({ left: 900 - ICEBERG_EDGE_PX - 79, top: 114 });
  });

  it("two sells on one candle: the bigger keeps its card above, the other keeps only its point rather than run its line through the bigger one's point or flip below", () => {
    const geometry = { xOf: () => 300, yOf: (price: number) => price, ...PANE };
    const marks = layoutIcebergs([
      iceberg({ id: "small", side: "ask", price: 200 }),
      iceberg({ id: "big", side: "ask", price: 150, display: 2, tranches: 80, executed: 160 }),
    ], {}, geometry, () => 1000);
    expect(at("big", marks)).toMatchObject({ lineEnd: 50, card: { top: 14, total: "160", breakdown: "(2 × 80)" } });
    expect(at("small", marks)).toMatchObject({ card: null, lineEnd: null, slot: null });
  });

  it("two buys on one candle: the upper card stops short of the lower point instead of running its line through it", () => {
    const geometry = { xOf: () => 300, yOf: (price: number) => price, ...PANE };
    const marks = layoutIcebergs([
      iceberg({ id: "upper", price: 100, markedAt: 1000 }),
      iceberg({ id: "lower", price: 180, markedAt: 1001 }),
    ], {}, geometry, () => 1000);
    expect(at("lower", marks)).toMatchObject({ lineEnd: 280, card: { top: 280 } });
    const stop = 180 - LONE_PX - ICEBERG_DOT_CLEARANCE_PX - ICEBERG_CARD_GAP_PX - ICEBERG_CARD.height;
    expect(at("upper", marks)).toMatchObject({ lineEnd: stop, slot: { down: true, length: stop - 100 }, card: { top: stop } });
    const nearTop = layoutIcebergs([
      iceberg({ id: "upper", price: 30, markedAt: 1000 }),
      iceberg({ id: "lower", price: 140, markedAt: 1001 }),
    ], {}, geometry, () => 1000);
    expect(at("lower", nearTop)).toMatchObject({ lineEnd: 240, card: { top: 240 } });
    expect(at("upper", nearTop)).toMatchObject({ lineEnd: stop - 40, slot: { down: true, length: stop - 70 }, card: { top: stop - 40 } });
  });

  it("two sells pinned under the top edge: the newer takes the short room above, the older has no clean room on its side and keeps only its point, never a card below", () => {
    const geometry = { xOf: (ms: number) => ms, yOf: () => 80, ...PANE };
    const marks = layoutIcebergs([iceberg({ id: "a", side: "ask", markedAt: 300 }), iceberg({ id: "b", side: "ask", markedAt: 320 })], {}, geometry, (ts) => ts);
    expect(at("b", marks)).toMatchObject({ lineEnd: 40, slot: { down: false, anchor: 0, length: 40 }, card: { left: 280.5, top: ICEBERG_EDGE_PX } });
    expect(at("a", marks)).toMatchObject({ card: null, lineEnd: null, slot: null });
  });

  it("a card keeps clear of other marks' points and lines when a slot on its side allows it", () => {
    const geometry = { xOf: (ms: number) => ms, yOf: (price: number) => price, width: 1000, height: 320 };
    const marks = layoutIcebergs([
      iceberg({ id: "high", side: "ask", markedAt: 300, price: 150 }),
      iceberg({ id: "low", side: "ask", markedAt: 330, price: 280 }),
    ], {}, geometry, (ts) => ts);
    expect(at("high", marks).card!.top).toBe(150 - ICEBERG_LINE_PX - ICEBERG_CARD.height);
    expect(at("low", marks).card!.top).toBe(150 + LONE_PX + ICEBERG_DOT_CLEARANCE_PX + ICEBERG_CARD_GAP_PX);
    expect(at("low", marks).lineEnd).toBe(at("low", marks).card!.top + ICEBERG_CARD.height);
  });

  it("a card stays in the pane: the line shortens near an edge, the card slides in from the sides, a side with no room leaves only the point, and a crowded card slides sideways on its side", () => {
    const [nearTop] = layoutIcebergs([iceberg({ side: "ask" })], {}, { xOf: () => 10, yOf: () => 80, width: 1000, height: 150 }, () => 1000);
    expect(nearTop.card).toMatchObject({ left: 0, top: ICEBERG_EDGE_PX });
    const [inset] = layoutIcebergs([iceberg({ side: "ask" })], {}, { xOf: () => 14, yOf: () => 80, width: 1000, height: 150 }, () => 1000);
    expect(inset.card).toMatchObject({ left: ICEBERG_EDGE_PX, top: ICEBERG_EDGE_PX });
    expect(nearTop.lineEnd).toBe(ICEBERG_EDGE_PX + ICEBERG_CARD.height);
    const [atTop] = layoutIcebergs([iceberg({ side: "ask" })], {}, { xOf: () => 300, yOf: () => 20, ...PANE }, () => 1000);
    expect(atTop).toMatchObject({ card: null, lineEnd: null, slot: null });
    const [atBottom] = layoutIcebergs([iceberg()], {}, { xOf: () => 300, yOf: () => 590, ...PANE }, () => 1000);
    expect(atBottom).toMatchObject({ card: null, lineEnd: null, slot: null });
    const [nearBottom] = layoutIcebergs([iceberg()], {}, { xOf: () => 995, yOf: () => 560, ...PANE }, () => 1000);
    expect(nearBottom).toMatchObject({ card: null, lineEnd: null, slot: null });
    const crowded = layoutIcebergs([iceberg({ id: "a", side: "ask", markedAt: 300 }), iceberg({ id: "b", side: "ask", markedAt: 320 })], {}, { xOf: (ms: number) => ms, yOf: () => 160, ...PANE }, (ts) => ts);
    expect(crowded.map((mark) => [mark.iceberg.id, mark.card!.left, mark.card!.top, mark.slot!.down])).toEqual([["a", 233, 64, false], ["b", 280.5, 24, false]]);
  });

  it("between two clean slots equally far from the plain line, the longer line wins", () => {
    const geometry = { xOf: (ms: number) => ms, yOf: (price: number) => price, width: 1000, height: 317 };
    const marks = layoutIcebergs([
      iceberg({ id: "ours", side: "ask", markedAt: 300, price: 250 }),
      iceberg({ id: "obstacle", side: "ask", markedAt: 330, price: 132, display: 1, tranches: 1, executed: 1 }),
    ], {}, geometry, (ts) => ts);
    const reach = icebergMarkRadius(1, icebergSizeReference([40, 1]), 1) + ICEBERG_DOT_CLEARANCE_PX;
    expect(reach).toBe(5.75);
    expect(at("ours", marks).slot).toMatchObject({ down: false, anchor: 0 });
    expect(at("ours", marks).slot!.length).toBe(122 + reach);
    expect(at("ours", marks).lineEnd).toBe(128 - reach);
  });

  it("a card never sits on a candle: the line runs on until the card clears the wicks under its span, at this zoom", () => {
    const candles = [{ x: 294, top: 160, bottom: 400 }, { x: 300, top: 120, bottom: 400 }, { x: 306, top: 140, bottom: 420 }];
    const [sell] = layoutIcebergs([iceberg({ side: "ask" })], {}, { xOf: () => 300, yOf: () => 250, candles, candleHalfPx: 3, ...PANE }, () => 1000);
    expect(sell).toMatchObject({ lineEnd: 116, slot: { down: false, length: 134 }, card: { top: 80 } });
    const [buy] = layoutIcebergs([iceberg()], {}, { xOf: () => 300, yOf: () => 250, candles, candleHalfPx: 3, ...PANE }, () => 1000);
    expect(buy).toMatchObject({ lineEnd: 424, slot: { down: true, length: 174 }, card: { top: 424 } });
    const [buyBelow] = layoutIcebergs([iceberg()], {}, { xOf: () => 300, yOf: () => 250, candles, candleHalfPx: 3, width: 1000, height: 1000 }, () => 1000);
    expect(buyBelow).toMatchObject({ lineEnd: 424, slot: { down: true, length: 174 } });
    const [walledAbove] = layoutIcebergs([iceberg()], {}, { xOf: () => 300, yOf: () => 250, candles: [{ x: 300, top: 60, bottom: 400 }], candleHalfPx: 3, ...PANE }, () => 1000);
    expect(walledAbove).toMatchObject({ lineEnd: 404, slot: { down: true, length: 154 }, card: { top: 404 } });
    const [clear] = layoutIcebergs([iceberg({ side: "ask" })], {}, { xOf: () => 300, yOf: () => 250, candles: [{ x: 360, top: 20, bottom: 400 }], candleHalfPx: 3, ...PANE }, () => 1000);
    expect(clear).toMatchObject({ lineEnd: 150, slot: { length: 100 } });
    const [edgeOfSpan] = layoutIcebergs([iceberg({ side: "ask" })], {}, { xOf: () => 300, yOf: () => 250, candles: [{ x: 341, top: 120, bottom: 400 }], candleHalfPx: 3, ...PANE }, () => 1000);
    expect(edgeOfSpan).toMatchObject({ lineEnd: 116, slot: { length: 134 } });
    const stale = new Map<string, IcebergSlot>([["a", { down: false, anchor: 0, length: 100 }]]);
    const [kept] = layoutIcebergs([iceberg({ side: "ask" })], {}, { xOf: () => 300, yOf: () => 250, candles, candleHalfPx: 3, ...PANE }, () => 1000, stale);
    expect(kept).toMatchObject({ lineEnd: 116, slot: { length: 134 } });
  });

  it("a sell's card is above and a buy's below, whatever is nearer: a sell under a tall wick runs its line up past the wick, and a candle that walls its side leaves only the point", () => {
    const walled = (top: number, bottom: number) => ({ xOf: () => 300, yOf: () => 250, candles: [{ x: 300, top, bottom }], candleHalfPx: 3, ...PANE });
    const [past] = layoutIcebergs([iceberg({ side: "ask" })], {}, walled(60, 300), () => 1000);
    expect(past).toMatchObject({ lineEnd: 56, slot: { down: false, length: 194 }, card: { top: 20 } });
    const [tie] = layoutIcebergs([iceberg({ side: "ask" })], {}, walled(142, 358), () => 1000);
    expect(tie).toMatchObject({ lineEnd: 138, slot: { down: false, length: 112 } });
    const [buyTie] = layoutIcebergs([iceberg()], {}, walled(142, 358), () => 1000);
    expect(buyTie).toMatchObject({ lineEnd: 362, slot: { down: true, length: 112 } });
    const [none] = layoutIcebergs([iceberg({ side: "ask" })], {}, walled(30, 580), () => 1000);
    expect(none).toMatchObject({ card: null, lineEnd: null, slot: null });
  });

  it("a mark with no clean room on either side keeps only its point", () => {
    const [squeezed] = layoutIcebergs([iceberg({ side: "ask" })], {}, { xOf: () => 300, yOf: () => 30, width: 1000, height: 60 }, () => 1000);
    expect(squeezed).toMatchObject({ x: 300, y: 30, card: null, lineEnd: null, slot: null });
  });

  it("placed on the candle, a sell's mark sits at the candle's high and a buy's at its low, the card still on its side; a candle with no bar under it keeps the price", () => {
    const candles = [{ x: 294, top: 160, bottom: 400 }, { x: 300, top: 120, bottom: 400 }, { x: 306, top: 140, bottom: 420 }];
    const geometry = { xOf: () => 300, yOf: () => 250, candles, candleHalfPx: 3, ...PANE };
    const marks = layoutIcebergs([iceberg({ id: "buy" }), iceberg({ id: "sell", side: "ask", markedAt: C + 601_000 })], { placement: "candle" }, geometry, () => 1000);
    expect(at("buy", marks)).toMatchObject({ x: 300, y: 400, r: LONE_PX, lineEnd: 500, slot: { down: true, length: 100 }, card: { top: 500 } });
    expect(at("sell", marks)).toMatchObject({ x: 300, y: 120, r: LONE_PX, lineEnd: 40, slot: { down: false, length: 80 }, card: { top: ICEBERG_EDGE_PX } });
    const [nearest] = layoutIcebergs([iceberg({ id: "sell", side: "ask" })], { placement: "candle" }, { ...geometry, xOf: () => 304, candleHalfPx: 4 }, () => 1000);
    expect(nearest).toMatchObject({ x: 304, y: 140 });
    const [noBar] = layoutIcebergs([iceberg({ id: "buy" })], { placement: "candle" }, { ...geometry, xOf: () => 500 }, () => 1000);
    expect(noBar).toMatchObject({ x: 500, y: 250 });
    const [atPrice] = layoutIcebergs([iceberg({ id: "buy" })], { placement: "price" }, geometry, () => 1000);
    expect(atPrice).toMatchObject({ x: 300, y: 250 });
    const [byDefault] = layoutIcebergs([iceberg({ id: "buy" })], {}, geometry, () => 1000);
    expect(byDefault).toMatchObject({ x: 300, y: 250 });
    const [offPane] = layoutIcebergs([iceberg({ id: "buy" })], { placement: "candle" }, { ...geometry, candles: [{ x: 300, top: 120, bottom: 601 }] }, () => 1000);
    expect(offPane).toBeUndefined();
  });

  it("with labels off a mark is only its point of contact", () => {
    const [mark] = layoutIcebergs([iceberg()], { labels: false }, { xOf: () => 300, yOf: () => 250, ...PANE }, () => 1000);
    expect(mark).toMatchObject({ x: 300, y: 250, card: null, lineEnd: null, slot: null });
  });

  it("cards go to live icebergs first, then the biggest totals, and stop at the card budget; the rest keep their points", () => {
    const geometry = { xOf: (ms: number) => ms, yOf: () => 250, width: 20_000, height: 600 };
    const settled = Array.from({ length: 100 }, (_, index) => iceberg({ id: `s${index}`, side: "ask", markedAt: 100 + index * 150, display: 10, tranches: index + 1, executed: 10 * (index + 1) - 1 }));
    const live = iceberg({ id: "live", side: "ask", status: "active", markedAt: 100 + 100 * 150, display: 10, tranches: 1, executed: 9 });
    const marks = layoutIcebergs([...settled, live], {}, geometry, (ts) => ts);
    expect(marks).toHaveLength(101);
    const carded = marks.filter((mark) => mark.card !== null).map((mark) => mark.iceberg.id);
    expect(carded).toHaveLength(ICEBERG_MAX_CARDS);
    expect(new Set(carded)).toEqual(new Set(["live", ...Array.from({ length: ICEBERG_MAX_CARDS - 1 }, (_, index) => `s${99 - index}`)]));
  });

  it("a card keeps last frame's slot while it is still clean and on its side, and gives it up when it is not", () => {
    const geometry = { xOf: (ms: number) => ms, yOf: () => 250, ...PANE };
    const previous = new Map<string, IcebergSlot>([["a", { down: false, anchor: 0, length: 60 }]]);
    expect(layoutIcebergs([iceberg({ side: "ask", markedAt: 300 })], {}, geometry, (ts) => ts, previous)[0].lineEnd).toBe(190);
    expect(layoutIcebergs([iceberg({ side: "ask", markedAt: 300 })], {}, geometry, (ts) => ts)[0].lineEnd).toBe(150);
    const wrongSide = new Map<string, IcebergSlot>([["a", { down: true, anchor: 0, length: 100 }]]);
    expect(layoutIcebergs([iceberg({ side: "ask", markedAt: 300 })], {}, geometry, (ts) => ts, wrongSide)[0]).toMatchObject({ lineEnd: 150, slot: { down: false, length: 100 } });
    const blocked = new Map<string, IcebergSlot>([["a", { down: false, anchor: 0, length: 100 }]]);
    const pair = layoutIcebergs([iceberg({ id: "a", side: "ask", markedAt: 300 }), iceberg({ id: "b", side: "ask", markedAt: 330 })], {}, geometry, (ts) => ts, blocked);
    expect(at("a", pair)).toMatchObject({ lineEnd: 190, slot: { down: false, anchor: -1, length: 60 } });
    const tooLong = new Map<string, IcebergSlot>([["a", { down: false, anchor: 0, length: 100 }]]);
    const [nearEdge] = layoutIcebergs([iceberg({ side: "ask", markedAt: 300 })], {}, { xOf: (ms: number) => ms, yOf: () => 100, ...PANE }, (ts) => ts, tooLong);
    expect(nearEdge).toMatchObject({ lineEnd: 40, slot: { down: false, length: 60 }, card: { top: ICEBERG_EDGE_PX } });
  });

  it("by default a native iceberg is a dot and a probable one a circle; circles and every weak, pulled or interrupted mark are outlines; a live one is fully opaque", () => {
    const geometry = { xOf: () => 50, yOf: () => 120, ...PANE };
    const list = [
      iceberg({ id: "p", kind: "probable", confidence: "strong", origin: "runtime", status: "active" }),
      iceberg({ id: "w", kind: "probable", confidence: "weak", origin: "runtime", status: "ended" }),
      iceberg({ id: "x", status: "pulled" }),
      iceberg({ id: "i", status: "interrupted" }),
      iceberg({ id: "n" }),
    ];
    const marks = layoutIcebergs(list, {}, geometry, () => 1000);
    expect(marks.map((mark) => [mark.iceberg.id, mark.shape, mark.hollow, mark.dashed, mark.alpha])).toEqual([
      ["p", "circle", true, false, 1], ["w", "circle", true, true, 0.8], ["x", "dot", true, true, 0.8], ["i", "dot", true, true, 0.8], ["n", "dot", false, false, 0.8],
    ]);
    const triangles = layoutIcebergs(list, { markShape: "triangle" }, geometry, () => 1000);
    expect(triangles.map((mark) => [mark.iceberg.id, mark.shape, mark.hollow])).toEqual([["p", "triangle", false], ["w", "triangle", true], ["x", "triangle", true], ["i", "triangle", true], ["n", "triangle", false]]);
    const circles = layoutIcebergs(list, { markShape: "circle" }, geometry, () => 1000);
    expect(circles.map((mark) => [mark.shape, mark.hollow])).toEqual([["circle", true], ["circle", true], ["circle", true], ["circle", true], ["circle", true]]);
    const dots = layoutIcebergs(list, { markShape: "dot" }, geometry, () => 1000);
    expect(dots.map((mark) => [mark.shape, mark.hollow])).toEqual([["dot", false], ["dot", true], ["dot", true], ["dot", true], ["dot", false]]);
  });

  it("a mark's size follows its total on a log scale against the typical iceberg on the chart: full size from ten typicals or at the biggest, the smallest size for nothing, in quarter pixels, times the mark size", () => {
    const lone = icebergSizeReference([40]);
    expect(lone).toEqual({ typical: 40, full: 400 });
    expect(icebergMarkRadius(40, lone, 1)).toBe(5.5);
    expect(icebergMarkRadius(400, lone, 1)).toBe(ICEBERG_DOT_MAX_PX);
    expect(icebergMarkRadius(4_000, lone, 1)).toBe(ICEBERG_DOT_MAX_PX);
    expect(icebergMarkRadius(0, lone, 1)).toBe(ICEBERG_DOT_MIN_PX);
    expect(icebergMarkRadius(40, lone, 2)).toBe(10.75);
    expect(icebergMarkRadius(40, icebergSizeReference([]), 1)).toBe(ICEBERG_DOT_MIN_PX);
    const es = icebergSizeReference([10, 10, 10, 10, 10, 20, 30, 50, 108, 486]);
    expect(es).toEqual({ typical: 10, full: 486 });
    expect([10, 20, 30, 50, 108, 486].map((total) => icebergMarkRadius(total, es, 1))).toEqual([4.75, 5.25, 5.75, 6.5, 7.5, ICEBERG_DOT_MAX_PX]);
    expect(icebergSizeReference([0, 3, 7, 1]).typical).toBe(3);
  });

  it("sizes are measured against every iceberg held, even ones scrolled out of view, so panning never resizes a mark", () => {
    const geometry = { xOf: (ms: number) => ms, yOf: () => 250, ...PANE };
    const offScreen = [iceberg({ id: "o1", markedAt: -50, display: 2, tranches: 2, executed: 4 }), iceberg({ id: "o2", markedAt: -60, display: 2, tranches: 2, executed: 4 })];
    const small = iceberg({ id: "small", markedAt: 300, display: 10, tranches: 4, executed: 32 });
    const [onScreen] = layoutIcebergs([...offScreen, small], {}, geometry, (ts) => ts);
    expect(onScreen.iceberg.id).toBe("small");
    expect(onScreen.r).toBe(ICEBERG_DOT_MAX_PX);
    expect(layoutIcebergs([small], {}, geometry, (ts) => ts)[0].r).toBe(LONE_PX);
  });

  it("a big mark keeps a visible line: a side too short for the mark plus a stretch of line gets no card, a kept slot that is too short is given up, and no slot beside another mark leaves less", () => {
    const tiny = iceberg({ id: "tiny", markedAt: -50, display: 1, tranches: 1, executed: 1 });
    const tight = { xOf: (ms: number) => (ms < 0 ? -1 : 300), yOf: () => 75, width: 1000, height: 150 };
    const huge = at("a", layoutIcebergs([iceberg({ side: "ask" }), tiny], { markScale: 3 }, tight, (ts) => ts));
    expect(huge).toMatchObject({ r: 3 * ICEBERG_DOT_MAX_PX, card: null, lineEnd: null });
    const plain = at("a", layoutIcebergs([iceberg({ side: "ask" }), tiny], {}, tight, (ts) => ts));
    expect(plain.card).not.toBeNull();
    expect(Math.abs(plain.lineEnd! - plain.y) - plain.r).toBeGreaterThanOrEqual(ICEBERG_LINE_VISIBLE_PX);
    const roomy = { xOf: (ms: number) => (ms < 0 ? -1 : 300), yOf: () => 300, ...PANE };
    const tall = at("a", layoutIcebergs([iceberg({ side: "ask" }), tiny], { markScale: 3 }, roomy, (ts) => ts));
    expect(Math.abs(tall.lineEnd! - tall.y) - tall.r).toBeGreaterThanOrEqual(ICEBERG_LINE_VISIBLE_PX);
    const short = new Map<string, IcebergSlot>([["a", { down: false, anchor: 0, length: 30 }]]);
    const replaced = at("a", layoutIcebergs([iceberg({ side: "ask" }), tiny], { markScale: 2.5 }, roomy, (ts) => ts, short));
    expect(replaced).toMatchObject({ r: 25, slot: { down: false, length: ICEBERG_LINE_PX } });
    const walled = { xOf: (ms: number) => ms, yOf: (price: number) => price, candles: [{ x: 300, top: 90, bottom: 590 }], candleHalfPx: 3, ...PANE };
    const pinned = layoutIcebergs([iceberg({ side: "ask", markedAt: 300, price: 100 }), iceberg({ id: "one", markedAt: 320, price: 17.25, display: 1, tranches: 1, executed: 1 })], { markScale: 2.5 }, walled, (ts) => ts);
    expect(at("a", pinned)).toMatchObject({ r: 25, card: null, lineEnd: null });
    expect(at("one", pinned).r).toBe(11.75);
  });

  it("a live iceberg inside a bigger mark on its candle still gets its card first, its line starting at the bigger mark's edge, and the bigger one, with its own side taken, keeps only its point", () => {
    const geometry = { xOf: () => 300, yOf: (price: number) => price, ...PANE };
    const ended = iceberg({ id: "ended", price: 250, markedAt: 1000, display: 27, tranches: 18, executed: 486 });
    const live = iceberg({ id: "live", price: 250, markedAt: 1001, status: "active", display: 6, tranches: 9, executed: 54 });
    const marks = layoutIcebergs([ended, live], {}, geometry, () => 1000);
    expect(at("live", marks)).toMatchObject({ r: 5.5, lineStart: 259.75, lineEnd: 350, slot: { down: true, length: ICEBERG_LINE_PX } });
    expect(at("ended", marks)).toMatchObject({ r: 9.75, card: null, lineStart: null, lineEnd: null });
    const lower = layoutIcebergs([ended, { ...live, price: 253 }], {}, geometry, () => 1000);
    expect(at("live", lower)).toMatchObject({ lineStart: 259.75, lineEnd: 353, slot: { down: true, length: ICEBERG_LINE_PX } });
    const pinnedLow = { xOf: () => 300, yOf: (price: number) => price, candles: [{ x: 300, top: 10, bottom: 520 }], candleHalfPx: 3, ...PANE };
    const low = layoutIcebergs([{ ...ended, price: 530 }, { ...live, price: 530 }], { markScale: 2.5 }, pinnedLow, () => 1000);
    expect(at("ended", low).r).toBe(24.25);
    expect(at("live", low)).toMatchObject({ r: 13.5, card: null, lineEnd: null });
  });

  it("a mark that only partly overlaps another keeps its line on its own mark, and two buys sharing the one side below leave the second with only its point", () => {
    const geometry = { xOf: () => 300, yOf: (price: number) => price, ...PANE };
    const marks = layoutIcebergs([
      iceberg({ id: "forty", price: 250, display: 10, tranches: 4, executed: 40 }),
      iceberg({ id: "thirty", price: 258, display: 10, tranches: 3, executed: 30 }),
    ], {}, geometry, () => 1000);
    expect(at("forty", marks)).toMatchObject({ r: 5.75, card: null, lineStart: null });
    expect(at("thirty", marks)).toMatchObject({ r: 5.5, lineStart: 263.5, lineEnd: 358, slot: { down: true } });
    const sell = layoutIcebergs([
      iceberg({ id: "forty", side: "ask", price: 250, display: 10, tranches: 4, executed: 40 }),
      iceberg({ id: "thirty", price: 258, display: 10, tranches: 3, executed: 30 }),
    ], {}, geometry, () => 1000);
    expect(at("forty", sell)).toMatchObject({ r: 5.75, lineStart: 244.25, lineEnd: 150, slot: { down: false } });
    expect(at("thirty", sell)).toMatchObject({ r: 5.5, lineStart: 263.5, lineEnd: 358, slot: { down: true } });
  });

  it("a mark inside a bigger one on another candle never borrows that mark's edge for its line", () => {
    const geometry = { xOf: (ms: number) => ms, yOf: (price: number) => price, ...PANE };
    const marks = layoutIcebergs([
      iceberg({ id: "ended", markedAt: 300, price: 250, display: 27, tranches: 18, executed: 486 }),
      iceberg({ id: "live", markedAt: 302, price: 251, status: "active", display: 6, tranches: 9, executed: 54 }),
    ], {}, geometry, (ts) => ts);
    expect(at("ended", marks).r).toBe(9.75);
    expect(at("live", marks)).toMatchObject({ r: 5.5, card: null, lineStart: null });
  });

  it("a mark inside several bigger marks on its candle starts its line past the farthest of them", () => {
    const geometry = { xOf: () => 300, yOf: (price: number) => price, ...PANE };
    const marks = layoutIcebergs([
      iceberg({ id: "big", price: 250, markedAt: 999, display: 27, tranches: 18, executed: 486 }),
      iceberg({ id: "mid", price: 254, markedAt: 1000, display: 6, tranches: 9, executed: 54 }),
      iceberg({ id: "small", price: 255, markedAt: 1001, status: "active", display: 10, tranches: 1, executed: 10 }),
    ], {}, geometry, () => 1000);
    expect(marks.map((mark) => [mark.iceberg.id, mark.r])).toEqual([["big", 9.75], ["mid", 5.5], ["small", 4]]);
    expect(at("small", marks)).toMatchObject({ lineStart: 259.75, slot: { down: true } });
  });

  it("a kept slot on a side that starts past a bigger mark must still leave that side's visible line", () => {
    const geometry = { xOf: () => 300, yOf: (price: number) => price, ...PANE };
    const ended = iceberg({ id: "ended", price: 250, markedAt: 1000, display: 27, tranches: 18, executed: 486 });
    const live = iceberg({ id: "live", price: 253, markedAt: 1001, status: "active", display: 6, tranches: 9, executed: 54 });
    const kept = new Map<string, IcebergSlot>([["live", { down: true, anchor: 0, length: 30 }]]);
    expect(at("live", layoutIcebergs([ended, live], { markScale: 2.5 }, geometry, () => 1000, kept))).toMatchObject({ r: 13.5, lineStart: 274.25, slot: { down: true, length: 30 } });
    const short = new Map<string, IcebergSlot>([["live", { down: true, anchor: 0, length: 29 }]]);
    expect(at("live", layoutIcebergs([ended, live], { markScale: 2.5 }, geometry, () => 1000, short)).slot).toMatchObject({ down: true, length: ICEBERG_LINE_PX });
  });

  it("a small mark's card and line keep clear of a bigger mark's disc beside it, at every mark size", () => {
    const geometry = { xOf: (ms: number) => ms, yOf: (price: number) => price, ...PANE };
    const clears = (big: IcebergMark, small: IcebergMark) => {
      const card = small.card!;
      const reach = big.r + ICEBERG_DOT_CLEARANCE_PX;
      const cardClear = big.x + reach <= card.left || big.x - reach >= card.left + card.width || big.y + reach <= card.top || big.y - reach >= card.top + card.height;
      const top = Math.min(small.lineStart!, small.lineEnd!);
      const bottom = Math.max(small.lineStart!, small.lineEnd!);
      return cardClear && (Math.abs(big.x - small.x) >= big.r + 0.75 || bottom <= big.y - big.r || top >= big.y + big.r);
    };
    for (const [markScale, bigX] of [[1, 254.5], [2.5, 245.5]]) {
      const marks = layoutIcebergs([
        iceberg({ id: "big", side: "ask", markedAt: bigX, price: 132, display: 10, tranches: 4, executed: 40 }),
        iceberg({ id: "small", side: "ask", markedAt: 300, price: 250, display: 10, tranches: 1, executed: 10 }),
      ], { markScale }, geometry, (ts) => ts);
      expect(at("small", marks)).toMatchObject({ slot: { down: false, anchor: 0 } });
      expect(at("small", marks).slot!.length).toBeGreaterThan(ICEBERG_LINE_PX);
      expect(clears(at("big", marks), at("small", marks))).toBe(true);
    }
    const beside = layoutIcebergs([
      iceberg({ id: "big", markedAt: 308, price: 200, display: 10, tranches: 4, executed: 40 }),
      iceberg({ id: "small", side: "ask", markedAt: 300, price: 250, display: 10, tranches: 1, executed: 10 }),
    ], {}, geometry, (ts) => ts);
    expect(at("small", beside)).toMatchObject({ card: null, lineEnd: null });
    const near = layoutIcebergs([
      iceberg({ id: "big", side: "ask", markedAt: 300, price: 250, display: 10, tranches: 4, executed: 40 }),
      iceberg({ id: "small", markedAt: 309, price: 180, display: 10, tranches: 1, executed: 10 }),
    ], {}, geometry, (ts) => ts);
    expect(at("big", near)).toMatchObject({ slot: { down: false, length: ICEBERG_LINE_PX } });
  });

  it("the hover takes a card before any point, the top card first, and the card's box ends at its edges plus a little slack", () => {
    const card = (left: number, top: number): IcebergCard => ({ left, top, width: 80, height: 36, total: "40", breakdown: "(10 × 4)" });
    const mark = (id: string, x: number, y: number, withCard: IcebergCard | null): IcebergMark => ({ x, y, r: 4.5, shape: "dot", hollow: false, dashed: false, alpha: 1, lineStart: null, lineEnd: null, card: withCard, slot: null, iceberg: iceberg({ id }) });
    const marks = [mark("under", 300, 400, card(100, 200)), mark("over", 300, 450, card(120, 210)), mark("dot", 94, 210, null)];
    expect(icebergMarkAt(marks, 101, 210)?.iceberg.id).toBe("under");
    expect(icebergMarkAt(marks, 130, 220)?.iceberg.id).toBe("over");
    expect(icebergMarkAt(marks, 92, 210)?.iceberg.id).toBe("dot");
    expect(icebergMarkAt(marks, 202, 215)?.iceberg.id).toBe("over");
    expect(icebergMarkAt(marks, 203, 240)).toBeNull();
    expect(icebergMarkAt(marks, 150, 248)?.iceberg.id).toBe("over");
    expect(icebergMarkAt(marks, 150, 249)).toBeNull();
  });

  it("the hover takes the mark drawn under the cursor, a small one on top of a bigger, newer one, then the nearest edge within a little slack, never a corner of blank chart", () => {
    const geometry = { xOf: (ms: number) => ms, yOf: (price: number) => price, ...PANE };
    const marks = layoutIcebergs([
      iceberg({ id: "small", markedAt: 490, price: 412, display: 10, tranches: 1, executed: 10 }),
      iceberg({ id: "mid", markedAt: 500, price: 410, display: 12, tranches: 9, executed: 108 }),
      iceberg({ id: "big", markedAt: 501, price: 400, display: 27, tranches: 18, executed: 486 }),
    ], { labels: false }, geometry, (ts) => ts);
    expect(marks.map((mark) => [mark.iceberg.id, mark.r])).toEqual([["big", 8], ["mid", 5.5], ["small", 3.75]]);
    expect(icebergMarkAt(marks, 500, 410)?.iceberg.id).toBe("mid");
    expect(icebergMarkAt(marks, 490, 412)?.iceberg.id).toBe("small");
    expect(icebergMarkAt(marks, 501, 400)?.iceberg.id).toBe("big");
    expect(icebergMarkAt(marks, 500, 389)?.iceberg.id).toBe("big");
    expect(icebergMarkAt(marks, 507, 407)?.iceberg.id).toBe("big");
    const lone = layoutIcebergs([iceberg({ id: "lone", markedAt: 501, price: 400 })], { labels: false }, geometry, (ts) => ts);
    const [mark] = lone;
    expect(icebergMarkAt(lone, mark.x + mark.r + 4, mark.y)?.iceberg.id).toBe("lone");
    expect(icebergMarkAt(lone, mark.x + mark.r + 5, mark.y)).toBeNull();
    expect(icebergMarkAt(lone, mark.x + mark.r + 3, mark.y + mark.r + 3)).toBeNull();
  });

  it("a triangle answers the hover inside its three sides only, so a corner of its box falls through to the mark beneath", () => {
    const make = (id: string, x: number, y: number, r: number, shape: IcebergMark["shape"]): IcebergMark => ({ x, y, r, shape, hollow: false, dashed: false, alpha: 1, lineStart: null, lineEnd: null, card: null, slot: null, iceberg: iceberg({ id }) });
    const marks = [make("big", 494, 396, 8, "dot"), make("tri", 500, 400, 3.75, "triangle")];
    expect(icebergMarkAt(marks, 497.5, 398)?.iceberg.id).toBe("big");
    expect(icebergMarkAt(marks, 500, 401)?.iceberg.id).toBe("tri");
  });

  it("a triangle's hover slack is measured to its drawn sides, bid or ask, so its corners answer, its empty box does not, and a nearer mark wins", () => {
    const make = (id: string, x: number, y: number, r: number, side: IcebergOrder["side"]): IcebergMark => ({ x, y, r, shape: "triangle", hollow: false, dashed: false, alpha: 1, lineStart: null, lineEnd: null, card: null, slot: null, iceberg: iceberg({ id, side }) });
    const bid = make("bid", 500, 400, 10, "bid");
    expect(icebergMarkAt([bid], 511, 411)?.iceberg.id).toBe("bid");
    expect(icebergMarkAt([bid], 500, 386.1)?.iceberg.id).toBe("bid");
    expect(icebergMarkAt([bid], 500, 385.5)).toBeNull();
    expect(icebergMarkAt([bid], 515, 420)).toBeNull();
    expect(icebergMarkAt([make("lone", 500, 400, 5.5, "bid")], 505.5, 394.5)).toBeNull();
    const ask = make("ask", 500, 400, 10, "ask");
    expect(icebergMarkAt([ask], 511, 389)?.iceberg.id).toBe("ask");
    expect(icebergMarkAt([ask], 500, 413.5)?.iceberg.id).toBe("ask");
    expect(icebergMarkAt([ask], 500, 414.5)).toBeNull();
    expect(icebergMarkAt([make("big", 500, 400, 10, "bid"), make("small", 512, 393, 5.5, "bid")], 506.5, 393)?.iceberg.id).toBe("small");
  });
});

describe("IcebergPrimitive on a chart", () => {
  const probableAsk = iceberg({ id: "b", kind: "probable", confidence: "probable", origin: "runtime", side: "ask", price: 2800, display: 1.5, executed: 12.475, tranches: 2, status: "ended" });

  it("draws every line first, then every point of contact, then every card, so no line runs over a card; lines take their side's colour", () => {
    const { primitive } = mounted([iceberg(), probableAsk]);
    const bid = at("a", primitive.marks);
    const ask = at("b", primitive.marks);
    expect([bid.x, bid.y, ask.x, ask.y]).toEqual([490, 240, 490, 220]);
    expect([bid.r, ask.r]).toEqual([7.25, 5.5]);
    const ops = drawn(primitive);
    const find = (op: string, args: unknown[]) => ops.findIndex((entry) => entry.op === op && JSON.stringify(entry.args) === JSON.stringify(args));
    const bidLine = find("moveTo", [490, 240 + bid.r]);
    const askLine = find("moveTo", [490, 220 - ask.r]);
    expect(bidLine).toBeGreaterThanOrEqual(0);
    expect(askLine).toBeGreaterThanOrEqual(0);
    expect(find("lineTo", [490, bid.lineEnd])).toBe(bidLine + 1);
    expect(find("lineTo", [490, ask.lineEnd])).toBe(askLine + 1);
    const strokeAfter = (index: number) => ops.slice(index).find((entry) => entry.op === "stroke")!;
    expect(strokeAfter(bidLine).strokeStyle).toBe(BID_SETTLED);
    expect(strokeAfter(askLine).strokeStyle).toBe(ASK_SETTLED);
    const lastLineStroke = ops.findIndex((entry, index) => index > Math.max(bidLine, askLine) && entry.op === "stroke");
    const firstArc = ops.findIndex((entry) => entry.op === "arc");
    const lastArc = ops.map((entry) => entry.op).lastIndexOf("arc");
    const firstCard = ops.findIndex((entry) => entry.op === "arcTo");
    expect(lastLineStroke).toBeGreaterThan(Math.max(bidLine, askLine));
    expect(lastLineStroke).toBeLessThan(firstArc);
    expect(lastArc).toBeLessThan(firstCard);
    expect(ops.findIndex((entry) => entry.op === "fillText")).toBeGreaterThan(firstCard);
    primitive.detached();
  });

  it("a native point is filled in its side's colour, a probable one is a ring round a light centre, and a dark chart darkens cards and ring centres", () => {
    const { primitive } = mounted([iceberg(), probableAsk]);
    const ops = drawn(primitive);
    const radius = (y: number) => primitive.marks.find((mark) => mark.y === y)!.r;
    const dotAt = (list: Op[], y: number) => list.findIndex((entry) => entry.op === "arc" && entry.args[0] === 490 && entry.args[1] === y && entry.args[2] === radius(y));
    const next = (list: Op[], index: number, op: string) => list.slice(index + 1).find((entry) => entry.op === op)!;
    const cardFill = (list: Op[]) => list.find((entry, index) => entry.op === "fill" && list[index - 1]?.op === "closePath" && list[index - 2]?.op === "arcTo")!;
    expect(next(ops, dotAt(ops, 240), "fill").fillStyle).toBe(BID_SETTLED);
    expect(dotAt(ops, 240)).toBeGreaterThanOrEqual(0);
    expect(dotAt(ops, 220)).toBeGreaterThanOrEqual(0);
    expect(next(ops, dotAt(ops, 220), "fill").fillStyle).toBe(ICEBERG_RING_CENTER);
    expect(next(ops, dotAt(ops, 220), "stroke")).toMatchObject({ strokeStyle: ASK_SETTLED, lineWidth: 2 });
    expect(cardFill(ops).fillStyle).toBe(ICEBERG_CARD_FILL);
    primitive.setDarkChart(true);
    primitive.updateAllViews();
    const dark = drawn(primitive);
    expect(next(dark, dotAt(dark, 220), "fill").fillStyle).toBe(ICEBERG_RING_CENTER_ON_DARK);
    expect(cardFill(dark).fillStyle).toBe(ICEBERG_CARD_FILL_ON_DARK);
    primitive.detached();
  });

  it("each card is drawn over its own box and writes ICEBERG, a green or red arrow, then the total with orders times size beside it", () => {
    const { primitive } = mounted([iceberg(), probableAsk]);
    const bid = at("a", primitive.marks).card!;
    const ask = at("b", primitive.marks).card!;
    expect([bid.total, bid.breakdown, ask.total, ask.breakdown]).toEqual(["40", "(10 × 4)", "13.5", "(1.5 × 9)"]);
    const ops = drawn(primitive);
    const outline = ops.filter((entry) => entry.op === "arcTo").slice(0, 4).map((entry) => entry.args.slice(0, 2));
    expect(outline).toEqual([[bid.left + bid.width, bid.top], [bid.left + bid.width, bid.top + bid.height], [bid.left, bid.top + bid.height], [bid.left, bid.top]]);
    const texts = ops.filter((entry) => entry.op === "fillText");
    expect(texts.map((entry) => entry.args[0])).toEqual(["ICEBERG", "40", "(10 × 4)", "ICEBERG", "13.5", "(1.5 × 9)"]);
    expect(texts.map((entry) => entry.font)).toEqual([ICEBERG_TITLE_FONT, ICEBERG_VALUE_FONT, ICEBERG_DETAIL_FONT, ICEBERG_TITLE_FONT, ICEBERG_VALUE_FONT, ICEBERG_DETAIL_FONT]);
    expect(texts.every((entry) => entry.textBaseline === "alphabetic" && entry.textAlign === "left")).toBe(true);
    const [title, total, breakdown] = texts;
    expect(title.args.slice(1)).toEqual([bid.left + ICEBERG_CARD.padX, bid.top + ICEBERG_CARD.titleBaseline]);
    expect(total.args.slice(1)).toEqual([bid.left + ICEBERG_CARD.padX, bid.top + ICEBERG_CARD.valueBaseline]);
    expect(breakdown.args[1] as number).toBeCloseTo(bid.left + ICEBERG_CARD.padX + textWidth("40", ICEBERG_CARD.valuePx) + ICEBERG_CARD.detailGap, 9);
    expect(breakdown.args[2]).toBe(bid.top + ICEBERG_CARD.valueBaseline);
    const arrowX = (card: IcebergCard) => card.left + ICEBERG_CARD.padX + textWidth(ICEBERG_CARD_TITLE, ICEBERG_CARD.titlePx) + ICEBERG_CARD.arrowGap + ICEBERG_CARD.arrowWidth / 2;
    const arrowStart = (card: IcebergCard, dy: number) => ops.findIndex((entry) => entry.op === "moveTo" && Math.abs((entry.args[0] as number) - arrowX(card)) < 1e-9 && entry.args[1] === card.top + ICEBERG_CARD.arrowMid + dy);
    const up = arrowStart(bid, -ICEBERG_CARD.arrowHeight / 2);
    const down = arrowStart(ask, ICEBERG_CARD.arrowHeight / 2);
    expect(up).toBeGreaterThan(0);
    expect(down).toBeGreaterThan(0);
    expect(ops.slice(up).find((entry) => entry.op === "fill")!.fillStyle).toBe(BID_SOLID);
    expect(ops.slice(down).find((entry) => entry.op === "fill")!.fillStyle).toBe(ASK_SOLID);
    primitive.setSettings({ historyDays: 5, bidColor: "#ff8800", askColor: "#0088ff" });
    primitive.updateAllViews();
    const recoloured = drawn(primitive);
    const arrows = recoloured.filter((entry, index) => entry.op === "fill" && recoloured[index - 1]?.op === "closePath" && recoloured[index - 2]?.op === "lineTo");
    expect(arrows.map((entry) => entry.fillStyle)).toEqual(["rgba(255, 136, 0, 1.000)", "rgba(0, 136, 255, 1.000)"]);
    primitive.detached();
  });

  it("a weak mark's line and point outline are dashed, a certain mark's are solid, and the dash never leaks into the cards", () => {
    const weak = iceberg({ id: "w", kind: "probable", confidence: "weak", origin: "runtime", status: "ended", price: 1000, markedAt: C + HALF + 1000 });
    const { primitive } = mounted([iceberg(), weak], { historyDays: 5 });
    const ops = drawn(primitive);
    const strokeAfter = (index: number) => ops.slice(index).find((entry) => entry.op === "stroke")!;
    const lineOf = (x: number, y: number) => ops.findIndex((entry) => entry.op === "moveTo" && entry.args[0] === x && entry.args[1] === y);
    const dotOf = (x: number, y: number) => ops.findIndex((entry) => entry.op === "arc" && entry.args[0] === x && entry.args[1] === y && entry.args[2] === LONE_PX);
    expect(strokeAfter(lineOf(490, 240 + LONE_PX)).dash).toEqual([]);
    expect(lineOf(490, 240 + LONE_PX)).toBeGreaterThanOrEqual(0);
    expect(lineOf(500, 400 + LONE_PX)).toBeGreaterThanOrEqual(0);
    expect(strokeAfter(lineOf(500, 400 + LONE_PX)).dash).toEqual([4, 3]);
    expect(strokeAfter(dotOf(490, 240)).dash).toEqual([]);
    expect(strokeAfter(dotOf(500, 400)).dash).toEqual([2, 2]);
    expect(ops.filter((entry) => entry.op === "arcTo" || entry.op === "fillText").every((entry) => entry.dash.length === 0)).toBe(true);
    primitive.detached();
  });

  it("with labels off only the points are drawn, and a weak point keeps its dashed outline", () => {
    const weak = iceberg({ id: "w", kind: "probable", confidence: "weak", origin: "runtime", status: "ended", price: 1000, markedAt: C + HALF + 1000 });
    const { primitive } = mounted([iceberg(), weak], { historyDays: 5, labels: false });
    const ops = drawn(primitive);
    expect(ops.filter((entry) => entry.op === "fillText" || entry.op === "lineTo" || entry.op === "arcTo")).toHaveLength(0);
    expect(ops.filter((entry) => entry.op === "arc" && entry.args[2] === LONE_PX)).toHaveLength(2);
    const weakDot = ops.findIndex((entry) => entry.op === "arc" && entry.args[1] === 400 && entry.args[2] === LONE_PX);
    expect(weakDot).toBeGreaterThanOrEqual(0);
    expect(ops.slice(weakDot).find((entry) => entry.op === "stroke")!.dash).toEqual([2, 2]);
    primitive.detached();
  });

  it("a triangle mark points up on a bid and down on an ask, filled, inside a halo of the same shape", () => {
    const { primitive } = mounted([iceberg(), probableAsk], { historyDays: 5, markShape: "triangle" });
    const bid = at("a", primitive.marks);
    const ask = at("b", primitive.marks);
    const ops = drawn(primitive);
    expect(ops.filter((entry) => entry.op === "arc")).toHaveLength(0);
    const apex = (x: number, y: number) => ops.findIndex((entry) => entry.op === "moveTo" && entry.args[0] === x && entry.args[1] === y);
    const bidHalo = apex(490, 240 - bid.r - 3);
    const bidBody = apex(490, 240 - bid.r);
    const askBody = apex(490, 220 + ask.r);
    expect(bidHalo).toBeGreaterThanOrEqual(0);
    expect(bidBody).toBeGreaterThan(bidHalo);
    expect(askBody).toBeGreaterThanOrEqual(0);
    expect(ops.slice(bidBody).find((entry) => entry.op === "fill")!.fillStyle).toBe(BID_SETTLED);
    expect(ops.slice(askBody).find((entry) => entry.op === "fill")!.fillStyle).toBe(ASK_SETTLED);
    const { context, ops: traced } = recordingContext();
    traceTriangle(context as never, 100, 200, 8, "bid");
    traceTriangle(context as never, 100, 200, 8, "ask");
    expect(traced.filter((op) => op.op === "moveTo" || op.op === "lineTo").map((op) => op.args)).toEqual([[100, 192], [108, 208], [92, 208], [100, 208], [108, 192], [92, 192]]);
    expect(traced.map((op) => op.op)).toEqual(["moveTo", "lineTo", "lineTo", "closePath", "moveTo", "lineTo", "lineTo", "closePath"]);
    primitive.detached();
  });

  it("a smaller mark is drawn over a bigger one whatever their order in the book, and the hover answers the one on top", () => {
    const small = iceberg({ id: "s", price: 2600, markedAt: C + 600_000, display: 10, tranches: 1, executed: 10 });
    const big = iceberg({ id: "g", price: 2620, markedAt: C + 600_001, display: 27, tranches: 18, executed: 486 });
    const { primitive } = mounted([small, big], { historyDays: 5, labels: false });
    expect([at("g", primitive.marks).r, at("s", primitive.marks).r]).toEqual([ICEBERG_DOT_MAX_PX, 4.75]);
    const ops = drawn(primitive);
    const body = (y: number, r: number) => ops.findIndex((entry) => entry.op === "arc" && entry.args[0] === 490 && entry.args[1] === y && entry.args[2] === r);
    expect(body(238, ICEBERG_DOT_MAX_PX)).toBeGreaterThanOrEqual(0);
    expect(body(240, 4.75)).toBeGreaterThan(body(238, ICEBERG_DOT_MAX_PX));
    expect(icebergMarkAt(primitive.marks, 490, 240)?.iceberg.id).toBe("s");
    primitive.detached();
  });

  it("the size slider and the pulled toggle only hide marks, a weak one is never hidden: every mark they keep keeps its size", () => {
    const list = [10, 10, 10, 10, 10, 20, 30, 50, 108, 486].map((total, index) => iceberg({ id: `t${index}`, price: 2600 + index, display: total, tranches: 1, executed: total, markedAt: C + 600_000 + index }));
    const radii = (icebergs: IcebergOrder[], settings: Parameters<IcebergPrimitive["setSettings"]>[0]) => {
      const { primitive } = mounted(icebergs, settings);
      const out = Object.fromEntries(primitive.marks.map((mark) => [mark.iceberg.id, mark.r]));
      primitive.detached();
      return out;
    };
    const all = radii(list, { historyDays: 5, labels: false });
    expect([all.t7, all.t8, all.t9]).toEqual([6.5, 7.5, ICEBERG_DOT_MAX_PX]);
    expect(radii(list, { historyDays: 5, labels: false, sizeTopPercent: 30 })).toEqual({ t7: all.t7, t8: all.t8, t9: all.t9 });
    const pulledBiggest = [...list.slice(0, 9), { ...list[9], status: "pulled" as const }];
    const hidden = radii(pulledBiggest, { historyDays: 5, labels: false });
    expect(hidden.t9).toBeUndefined();
    expect(hidden.t8).toBe(all.t8);
    const weakBiggest = [...list.slice(0, 9), { ...list[9], kind: "probable" as const, confidence: "weak" as const }];
    expect(radii(weakBiggest, { historyDays: 5, labels: false }).t8).toBe(all.t8);
  });

  it("the history span and the pulled toggle decide what is laid out, off keeps the runtime's own and leaves the host's out, and a mark older than the loaded candles has no column", () => {
    const old = iceberg({ id: "old", markedAt: C + H1 - 2 * 86_400_000 });
    const earlier = iceberg({ id: "earlier", markedAt: C + 60_000 });
    const pulled = iceberg({ id: "pulled", status: "pulled" });
    expect(mounted([iceberg(), earlier, old, pulled], { historyDays: 1 }).primitive.marks.map((mark) => mark.iceberg.id)).toEqual(["earlier", "a"]);
    expect(mounted([iceberg(), earlier, old, pulled], { historyDays: 3, showPulled: true }).primitive.marks.map((mark) => mark.iceberg.id)).toEqual(["earlier", "a", "pulled"]);
    const hosted = iceberg({ id: "hosted", origin: "host", markedAt: C + 120_000 });
    const { primitive, book } = mounted([iceberg(), earlier, old, hosted], { historyDays: 0 });
    expect(primitive.marks.map((mark) => mark.iceberg.id)).toEqual(["earlier", "a"]);
    book.clear();
    book.apply({ ...page([iceberg(), earlier, old, hosted, iceberg({ id: "since", markedAt: C + 2_000_000 })]), ts: C + 1_800_000 });
    primitive.updateAllViews();
    expect(primitive.marks.map((mark) => mark.iceberg.id)).toEqual(["earlier", "a", "since"]);
    primitive.detached();
  });

  it("from the hour up the layout keeps one mark a candle, the biggest by total; below the hour it keeps them all", () => {
    const small = iceberg({ id: "small", markedAt: C + 10_000, display: 10, tranches: 2, executed: 20 });
    const big = iceberg({ id: "big", markedAt: C + 20_000, display: 10, tranches: 4, executed: 40 });
    const next = iceberg({ id: "next", markedAt: C + H1 + 10_000, display: 1, tranches: 2, executed: 2 });
    const { primitive, world } = mounted([small, big, next], { historyDays: 5 });
    expect(primitive.marks.map((mark) => mark.iceberg.id).sort()).toEqual(["big", "small"]);
    world.bars = [{ time: C / 1000, open: 2600, high: 2605, low: 2595, close: 2600 }, { time: C / 1000 + 3_600, open: 2600, high: 2605, low: 2595, close: 2600 }];
    primitive.updateAllViews();
    expect(primitive.marks.map((mark) => mark.iceberg.id).sort()).toEqual(["big", "next"]);
    primitive.detached();
  });

  it("the layout runs once per change: repeated paints with nothing new reuse it, a new page or a live wick lays out again", () => {
    const { primitive, book, counts, live } = mounted([iceberg()]);
    const first = primitive.marks;
    const afterFirst = counts.price;
    primitive.updateAllViews();
    expect(primitive.marks).toBe(first);
    const keyOnly = counts.price - afterFirst;
    primitive.updateAllViews();
    expect(counts.price - afterFirst).toBe(2 * keyOnly);
    book.apply(page([iceberg({ id: "n", price: 2500 })], 1, false));
    primitive.updateAllViews();
    expect(primitive.marks).not.toBe(first);
    expect(primitive.marks.map((mark) => mark.iceberg.id)).toEqual(["a", "n"]);
    expect(counts.price - afterFirst).toBe(3 * keyOnly + 2 + 2 * 2);
    expect(keyOnly).toBe(2);
    const before = primitive.marks;
    live.high = 2700;
    primitive.updateAllViews();
    expect(primitive.marks).not.toBe(before);
    primitive.detached();
  });

  it("the layout runs again when the price scale, the time scale, the pane, the bar window or the settings change with the same page", () => {
    const relaidOut = (change: (world: ReturnType<typeof mounted>["world"]) => void) => {
      const mount = mounted([iceberg()]);
      const before = mount.primitive.marks;
      change(mount.world);
      mount.primitive.updateAllViews();
      const changed = mount.primitive.marks !== before;
      mount.primitive.detached();
      return changed;
    };
    expect(relaidOut(() => {})).toBe(false);
    expect(relaidOut((world) => { world.priceShift = 80; })).toBe(true);
    expect(relaidOut((world) => { world.timeShift = 120; })).toBe(true);
    expect(relaidOut((world) => { world.height = 700; })).toBe(true);
    expect(relaidOut((world) => { world.width = 1200; })).toBe(true);
    expect(relaidOut((world) => { world.bars.forEach((bar) => { bar.time += 3_600; }); })).toBe(true);
    expect(relaidOut((world) => { world.primitive.setSettings({ historyDays: 5, labels: false }); })).toBe(true);
    expect(relaidOut((world) => { world.primitive.setRightInset(() => 200); })).toBe(true);
  });

  it("a card keeps its slot across pages while it stays clean, even when a fresh layout would move it", () => {
    const older = iceberg({ id: "o", side: "ask", markedAt: C + HALF + 500 });
    const { primitive, book, live } = mounted([older]);
    expect(at("o", primitive.marks)).toMatchObject({ x: 500, lineEnd: 140, slot: { down: false, anchor: 0, length: 100 }, card: { top: 104 } });
    live.high = 3700;
    primitive.updateAllViews();
    expect(at("o", primitive.marks)).toMatchObject({ lineEnd: 126, slot: { down: false, anchor: 0, length: 114 }, card: { top: 90 } });
    live.high = 2605;
    primitive.updateAllViews();
    expect(at("o", primitive.marks)).toMatchObject({ lineEnd: 126, slot: { down: false, anchor: 0, length: 114 } });
    const buy = iceberg({ id: "b", markedAt: C + 600_000, price: 2400, updatedAt: C + HALF + 1500 });
    book.apply(page([buy], 1, false));
    primitive.updateAllViews();
    expect(at("b", primitive.marks)).toMatchObject({ x: 490, y: 260, lineEnd: 360, slot: { down: true, length: 100 } });
    expect(at("o", primitive.marks)).toMatchObject({ lineEnd: 126, slot: { down: false, anchor: 0, length: 114 } });
    primitive.detached();
    const fresh = mounted([older, buy]);
    expect(at("o", fresh.primitive.marks)).toMatchObject({ lineEnd: 140, slot: { down: false, anchor: 0, length: 100 } });
    fresh.primitive.detached();
  });

  it("the hover finds the mark at its point or anywhere on its card, cardAt only on a card, and nothing elsewhere", () => {
    const { primitive } = mounted([iceberg()]);
    const [mark] = primitive.marks;
    const card = mark.card!;
    expect(primitive.markAt(mark.x + mark.r + 3, mark.y)?.title).toBe("Native iceberg · bid");
    expect(primitive.markAt(card.left + 2, card.top + card.height - 2)?.headline).toBe("Total 40 BTC · 4 orders of 10 BTC");
    expect(primitive.cardAt(card.left + 2, card.top + 2)?.kind).toBe("native");
    expect(primitive.cardAt(mark.x, mark.y)).toBeNull();
    expect(primitive.markAt(mark.x + mark.r + 20, mark.y)).toBeNull();
    expect(primitive.markAt(card.left - 10, card.top + 5)).toBeNull();
    primitive.detached();
    expect(primitive.markAt(mark.x, mark.y)).toBeNull();
    const bare = mounted([iceberg()], { historyDays: 5, labels: false }).primitive;
    expect(bare.markAt(card.left + 2, card.top + card.height - 2)).toBeNull();
    expect(bare.markAt(mark.x, mark.y)?.kind).toBe("native");
  });

  it("the badge says waiting until a page arrives, untrusted after a dropped socket, and nothing while in sync; a layer that is not shown, off or hidden, prints no badge at all", () => {
    const WAITING = "ICEBERG DETECTOR · WAITING FOR THE FEED";
    const UNTRUSTED = "ICEBERG DETECTOR · UNTRUSTED UNTIL THE NEXT PAGE";
    expect(icebergStatusText(null, true)).toBe(WAITING);
    expect(icebergStatusText(null, false)).toBeNull();
    const book = new IcebergBook();
    expect(icebergStatusText(book, true)).toBe(WAITING);
    book.apply(page([]));
    expect(icebergStatusText(book, true)).toBeNull();
    book.markUntrusted();
    expect(icebergStatusText(book, true)).toBe(UNTRUSTED);
    expect(icebergStatusText(book, false)).toBeNull();
    const badgeOf = (layer: IcebergPrimitive) => {
      const { context, ops } = recordingContext();
      layer.paneViews()[1].renderer()!.draw({ useMediaCoordinateSpace: (paint: (scope: unknown) => void) => paint({ context }) } as never);
      return ops.find((entry) => entry.op === "fillText")?.args[0] ?? null;
    };
    expect(badgeOf(new IcebergPrimitive())).toBeNull();
    const { primitive } = mounted([]);
    primitive.book?.markUntrusted();
    expect(badgeOf(primitive)).toBe(UNTRUSTED);
    primitive.setShown(false);
    expect(badgeOf(primitive)).toBeNull();
    primitive.setBook(null);
    expect(badgeOf(primitive)).toBeNull();
    primitive.setShown(true);
    expect(badgeOf(primitive)).toBe(WAITING);
    expect(STATUS_BADGE_SLOT.iceberg).toBe(7);
    primitive.detached();
  });
});
