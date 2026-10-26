import { describe, expect, it } from "vitest";
import type { BarFrame, LiquidityPrint } from "../../../../types/frames";
import type { ColumnFeed } from "../../absorption-detector/absorptionColumns";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import type { LevelRules } from "../levelReader";
import { COVERAGE_SHARE, DELTA_SHARE, WINDOW_MS, attackRows, readWindow, touchTime } from "../levelWindow";

const T0 = 1_700_000_000_000;
const S = 1_000;
const MINUTE = 60 * S;
const END = T0 + WINDOW_MS;
// A high at 100 on a row of one: the wall's band rows 100..103, its far edge 104, the attack rows 96..103. NQ-like rules: floor 75, volume twice the wall.
const HIGH = 100;
const RULES: LevelRules = { bandRows: 4, floor: 75, share: 2 };

interface Spec {
  ask?: Record<number, number>;
  bid?: Record<number, number>;
  prints?: [side: "buy" | "sell", price: number, size: number][];
  buy?: [number, number][];
  sell?: [number, number][];
  /** Where the book's mid sits: the best bid row; the best ask is the row above, and no ask rests at or under it, no bid over it. Rows 80..130. Default under the level. */
  mid?: number;
}

/** Ten-second columns over rows 80..130 from T0; `at(i)` gives column i its book, flow and mid. Six minutes by default. */
function feedOf(at: (index: number) => Spec, count = 36): ColumnFeed {
  const columns: LiquidityColumn[] = [];
  for (let i = 0; i < count; i += 1) {
    const spec = at(i);
    const ask = new Float64Array(51);
    const bid = new Float64Array(51);
    const mid = spec.mid ?? 97;
    bid[mid - 80] = 5;
    ask[mid + 1 - 80] = 5;
    for (const [row, size] of Object.entries(spec.ask ?? {})) ask[Number(row) - 80] = size;
    for (const [row, size] of Object.entries(spec.bid ?? {})) bid[Number(row) - 80] = size;
    for (let row = 80; row <= 130; row += 1) {
      if (row <= mid) ask[row - 80] = 0;
      else bid[row - 80] = 0;
    }
    const ts = T0 + i * 10 * S;
    const prints: LiquidityPrint[] = (spec.prints ?? []).map(([side, price, size]) => ({ ts, price, size, side, id: null }));
    columns.push({ ts, lo: 80, hi: 130, ask, bid, prints, buy: spec.buy ?? [], sell: spec.sell ?? [] });
  }
  return { epoch: 1, deep: null, fine: { columns, columnMs: 10 * S } };
}

function bar(ts_open: number, high: number, low: number): BarFrame {
  return {
    type: "bar", symbol: "/NQZ26:XCME", provider: "DXFEED", assetClass: "FUTURE", interval_ms: MINUTE, ts_open,
    open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 0, trade_count: 1, closed: true,
  } as BarFrame;
}

const wall = (size = 200): Spec => ({ ask: { 101: size } });

describe("readWindow on a high", () => {
  it("runs five minutes from the touch and stays open, with no verdict, while the columns have not reached its end", () => {
    const reading = readWindow(feedOf(() => wall()), 1, [], HIGH, "high", RULES, T0, T0 + 3 * MINUTE);
    expect(reading).toMatchObject({ from: T0, to: END, open: true, noBook: false, verdict: null });
    expect(reading.facts).toMatchObject({ before: 200, now: 200, into: 0, columns: 19 });
    expect(WINDOW_MS).toBe(5 * MINUTE);
  });

  it("reads held when price stayed inside and nothing traded into the wall, and says what rested", () => {
    const reading = readWindow(feedOf(() => wall()), 1, [bar(T0, 100, 96)], HIGH, "high", RULES, T0, END);
    expect(reading).toMatchObject({ open: false, verdict: "held" });
    expect(reading.facts).toMatchObject({ before: 200, now: 200, wentPast: false, outAtEnd: false, columns: 30 });
  });

  it("reads absorbed when volume at the floor and the share traded into the wall and it held, price inside at the end, a wick past the band or not", () => {
    const feed = feedOf((i) => ({ ...wall(40), buy: i === 6 ? [[101, 100]] : [] }));
    expect(readWindow(feed, 1, [], HIGH, "high", RULES, T0, END)).toMatchObject({ verdict: "absorbed", facts: { before: 40, into: 100 } });
    expect(readWindow(feed, 1, [bar(T0 + MINUTE, 106, 98)], HIGH, "high", RULES, T0, END)).toMatchObject({ verdict: "absorbed", facts: { wentPast: true } });
  });

  it("reads held, not absorbed, when the volume reached the share of a small wall but stayed under the floor", () => {
    const feed = feedOf((i) => ({ ...wall(10), buy: i === 6 ? [[101, 30]] : [] }));
    expect(readWindow(feed, 1, [], HIGH, "high", RULES, T0, END)).toMatchObject({ verdict: "held", facts: { before: 10, into: 30 } });
  });

  it("reads held, not absorbed, when the volume ate the wall to under half but price never left the level", () => {
    const feed = feedOf((i) => ({ ...wall(i < 7 ? 40 : 10), buy: i === 6 ? [[101, 100]] : [] }));
    expect(readWindow(feed, 1, [], HIGH, "high", RULES, T0, END)).toMatchObject({ verdict: "held", facts: { before: 40, now: 10, into: 100 } });
  });

  it("reads what rested in the column before the first trade into it, not at the touch", () => {
    const feed = feedOf((i) => ({ ...wall(i < 4 ? 400 : 60), buy: i === 6 ? [[101, 100]] : [] }));
    expect(readWindow(feed, 1, [], HIGH, "high", RULES, T0, END).facts).toMatchObject({ before: 60, into: 100 });
  });

  it("reads swept when a wick went past the band and price came back with no absorption -- volume under the floor, or under the share, or none", () => {
    const wick = [bar(T0 + MINUTE, 105, 98)];
    expect(readWindow(feedOf(() => wall()), 1, wick, HIGH, "high", RULES, T0, END)).toMatchObject({ verdict: "swept", facts: { into: 0, wentPast: true, outAtEnd: false } });
    const small = feedOf((i) => ({ ...wall(), buy: i === 6 ? [[101, 70]] : [] }));
    expect(readWindow(small, 1, wick, HIGH, "high", RULES, T0, END)).toMatchObject({ verdict: "swept", facts: { into: 70 } });
    const underShare = feedOf((i) => ({ ...wall(), buy: i === 6 ? [[101, 300]] : [] }));
    expect(readWindow(underShare, 1, wick, HIGH, "high", RULES, T0, END)).toMatchObject({ verdict: "swept", facts: { into: 300 } });
  });

  it("sees a move past the band in the columns' mid too, so a fifteen-minute bar still gives a sweep", () => {
    const feed = feedOf((i) => ({ ...wall(), mid: i >= 10 && i <= 12 ? 105 : 97 }));
    expect(readWindow(feed, 1, [], HIGH, "high", RULES, T0, END)).toMatchObject({ verdict: "swept", facts: { wentPast: true, outAtEnd: false } });
  });

  it("counts only a wick past the band's far edge, not one inside it", () => {
    expect(readWindow(feedOf(() => wall()), 1, [bar(T0 + MINUTE, 104, 98)], HIGH, "high", RULES, T0, END).verdict).toBe("held");
    expect(readWindow(feedOf(() => wall()), 1, [bar(T0 + MINUTE, 104.5, 98)], HIGH, "high", RULES, T0, END).verdict).toBe("swept");
  });

  it("ignores bars outside the window", () => {
    const outside = [bar(T0 - 2 * MINUTE, 110, 98), bar(END, 110, 98)];
    expect(readWindow(feedOf(() => wall()), 1, outside, HIGH, "high", RULES, T0, END).facts.wentPast).toBe(false);
    expect(readWindow(feedOf(() => wall()), 1, [bar(T0 - MINUTE + 10 * S, 110, 98)], HIGH, "high", RULES, T0, END).facts.wentPast).toBe(true);
  });

  it("counts the attack on both sides of the level, the band's rows under it and over it, and only the attacking side", () => {
    // Sells into a high are not an attack; buys past the band's far edge went through, not into; buys under the level, within the band's rows, did.
    const feed = feedOf((i) => ({ ...wall(), sell: i === 2 ? [[101, 500]] : [], buy: i === 2 ? [[104, 500], [95, 500]] : [] }));
    expect(readWindow(feed, 1, [bar(T0 + MINUTE, 105, 98)], HIGH, "high", RULES, T0, END)).toMatchObject({ verdict: "swept", facts: { into: 0, through: 500 } });
    const under = feedOf((i) => ({ ...wall(40), buy: i === 2 ? [[97, 60], [96, 50]] : [] }));
    expect(readWindow(under, 1, [], HIGH, "high", RULES, T0, END)).toMatchObject({ verdict: "absorbed", facts: { into: 110, through: 0, before: 40 } });
    expect(attackRows(100, "high", 1, 4)).toEqual([96, 103]);
    expect(attackRows(100, "low", 1, 4)).toEqual([97, 104]);
  });

  it("reads a strong break when price is out at the end, volume at the floor went through the level and delta went with the break", () => {
    const feed = feedOf((i) => ({
      ask: { 101: i < 8 ? 200 : 60 },
      mid: i >= 8 ? 106 : 97,
      buy: i === 7 ? [[101, 150]] : [],
      sell: i === 7 ? [[101, 20]] : [],
      bid: i >= 20 ? { 102: 90 } : undefined,
    }));
    const reading = readWindow(feed, 1, [], HIGH, "high", RULES, T0, END);
    expect(reading).toMatchObject({ verdict: "strongBreak", facts: { before: 200, now: 0, into: 150, through: 150, against: 20, delta: 130, outAtEnd: true, wentPast: true } });
  });

  it("reads a weak break when price is out at the end but the book did not confirm: wall pulled with nothing traded through, or volume through under the floor, or delta against or too small", () => {
    const out = (over: (i: number) => Partial<Spec>) => feedOf((i) => ({ ask: { 101: i < 8 ? 200 : 60 }, mid: i >= 8 ? 106 : 97, buy: i === 7 ? [[101, 150]] : [], ...over(i) }));
    expect(readWindow(out(() => ({ buy: [] })), 1, [], HIGH, "high", RULES, T0, END)).toMatchObject({ verdict: "weakBreak", facts: { into: 0, through: 0, now: 0, outAtEnd: true } });
    expect(readWindow(out((i) => ({ buy: i === 7 ? [[101, 70]] : [] })), 1, [], HIGH, "high", RULES, T0, END).verdict).toBe("weakBreak");
    expect(readWindow(out((i) => ({ sell: i === 7 ? [[101, 300]] : [] })), 1, [], HIGH, "high", RULES, T0, END).verdict).toBe("weakBreak");
    expect(readWindow(out((i) => ({ sell: i === 7 ? [[101, 120]] : [] })), 1, [], HIGH, "high", RULES, T0, END)).toMatchObject({ verdict: "weakBreak", facts: { delta: 30 } });
    expect(DELTA_SHARE).toBe(0.25);
  });

  it("judges where price is by the last column read, so a break that came back inside before the end is a sweep", () => {
    const feed = feedOf((i) => ({ ask: { 101: i < 8 ? 200 : 60 }, mid: i >= 8 && i < 25 ? 106 : 97, buy: i === 7 ? [[101, 150]] : [] }));
    expect(readWindow(feed, 1, [], HIGH, "high", RULES, T0, END)).toMatchObject({ verdict: "swept", facts: { outAtEnd: false, wentPast: true } });
  });

  it("reads no book when the columns do not cover the window at all, or do not reach back to its start", () => {
    const empty: ColumnFeed = { epoch: 1, deep: null, fine: { columns: [], columnMs: 10 * S } };
    expect(readWindow(empty, 1, [bar(T0, 105, 98)], HIGH, "high", RULES, T0, END)).toMatchObject({ open: false, noBook: true, verdict: null, facts: { columns: 0, wentPast: true } });
    expect(readWindow(empty, 1, [], HIGH, "high", RULES, T0, T0 + MINUTE)).toMatchObject({ open: true, noBook: true });
    // Columns from two minutes in: a verdict on them would be one on three of the five minutes, so it waits for a fuller book.
    const late = feedOf(() => wall());
    expect(readWindow(late, 1, [], HIGH, "high", RULES, T0 - 2 * MINUTE, END)).toMatchObject({ open: false, noBook: true, verdict: null });
    expect(readWindow(late, 1, [], HIGH, "high", RULES, T0 - 10 * S, END)).toMatchObject({ noBook: false, verdict: "held" });
  });

  it("does not grade a five-minute level when the book disappears inside the window, even without candle volume", () => {
    const full = feedOf(() => wall());
    const gapped: ColumnFeed = { ...full, fine: { ...full.fine, columns: full.fine.columns.filter((column) => column.ts < T0 + MINUTE || column.ts >= T0 + 3 * MINUTE) } };
    expect(readWindow(gapped, 1, [], HIGH, "high", RULES, T0, END)).toMatchObject({ open: false, partial: true, bookGap: true, verdict: null });
  });

  it("holds its verdict as partial data when the book caught under four fifths of the candles' volume in the window, the candles' share prorated to the window", () => {
    expect(COVERAGE_SHARE).toBe(0.8);
    // 300 in the book against 500 by the candles: 60% caught.
    const feed = feedOf((i) => ({ ...wall(), buy: [[101, 6]], sell: [[99, 4]], mid: i >= 8 ? 106 : 97 }));
    const candles = (volume: number, count = 5) => Array.from({ length: count }, (_, i) => ({ ...bar(T0 + i * MINUTE, 103, 98), volume }));
    const thin = readWindow(feed, 1, candles(100), HIGH, "high", RULES, T0, END);
    expect(thin).toMatchObject({ open: false, noBook: false, partial: true, verdict: null, facts: { captured: 300, expected: 500 } });
    // 300 of 375 is 80%: enough for a verdict.
    expect(readWindow(feed, 1, candles(75), HIGH, "high", RULES, T0, END)).toMatchObject({ partial: false, verdict: "strongBreak", facts: { captured: 300, expected: 375 } });
    // No candles at all, or candles without volume, is no claim about coverage.
    expect(readWindow(feed, 1, [], HIGH, "high", RULES, T0, END)).toMatchObject({ partial: false, verdict: "strongBreak", facts: { expected: 0 } });
    // A five-minute candle that overlaps the window by two minutes counts two fifths of its volume.
    const wide = { ...bar(T0 - 3 * MINUTE, 103, 98), interval_ms: 5 * MINUTE, volume: 1000 };
    expect(readWindow(feed, 1, [wide], HIGH, "high", RULES, T0, END).facts.expected).toBe(400);
    // While the window is open there is no partial verdict either, only Testing.
    expect(readWindow(feed, 1, candles(100), HIGH, "high", RULES, T0, T0 + 2 * MINUTE)).toMatchObject({ open: true, partial: false, verdict: null });
  });

  it("reads only the columns inside the window, none before the touch and none after its end", () => {
    const feed = feedOf((i) => ({ ...wall(), buy: i === 0 || i === 31 ? [[101, 500]] : [] }), 40);
    expect(readWindow(feed, 1, [], HIGH, "high", RULES, T0 + 10 * S, END + 10 * S).facts).toMatchObject({ columns: 30, into: 0 });
  });
});

describe("readWindow on a low", () => {
  it("mirrors the high: bids at and below, sells into it, a wick under the band's bottom edge", () => {
    const LOW = 100;
    const held = feedOf(() => ({ bid: { 99: 200 }, mid: 102 }));
    expect(readWindow(held, 1, [bar(T0, 104, 100)], LOW, "low", RULES, T0, END).verdict).toBe("held");
    const absorbed = feedOf((i) => ({ bid: { 99: 40 }, mid: 102, sell: i === 6 ? [[99, 100]] : [], buy: i === 6 ? [[99, 900]] : [] }));
    expect(readWindow(absorbed, 1, [], LOW, "low", RULES, T0, END)).toMatchObject({ verdict: "absorbed", facts: { into: 100, before: 40 } });
    expect(readWindow(held, 1, [bar(T0 + MINUTE, 104, 96)], LOW, "low", RULES, T0, END).verdict).toBe("swept");
    expect(readWindow(held, 1, [bar(T0 + MINUTE, 104, 97)], LOW, "low", RULES, T0, END).verdict).toBe("held");
    const broken = feedOf((i) => ({ bid: { 99: i < 8 ? 200 : 40 }, mid: i >= 8 ? 92 : 102, sell: i === 7 ? [[99, 150]] : [], ask: i >= 20 ? { 98: 120 } : undefined }));
    expect(readWindow(broken, 1, [], LOW, "low", RULES, T0, END)).toMatchObject({ verdict: "strongBreak", facts: { delta: 150, outAtEnd: true } });
  });
});

describe("touchTime", () => {
  it("puts the touch on the first column of the bar whose mid reached the band or went beyond, the level's own row included, and on the bar's open when the mid never did", () => {
    // A best bid at 99 and best ask at 100 put the mid on the level's row, 100: reached.
    const feed = feedOf((i) => ({ mid: i >= 3 ? 99 : 97 }), 6);
    expect(touchTime(feed, 1, bar(T0, 100, 96), HIGH, "high")).toBe(T0 + 30 * S);
    expect(touchTime(feed, 1, bar(T0 + 2 * MINUTE, 100, 96), HIGH, "high")).toBe(T0 + 2 * MINUTE);
    const wickOnly = feedOf(() => ({ mid: 97 }), 6);
    expect(touchTime(wickOnly, 1, bar(T0, 100, 96), HIGH, "high")).toBe(T0);
    const low = feedOf((i) => ({ mid: i >= 2 ? 99 : 103 }), 6);
    expect(touchTime(low, 1, bar(T0, 104, 100), 100, "low")).toBe(T0 + 20 * S);
  });
});

describe("the best verdict a window can give from what it has", () => {
  const empty: ColumnFeed = { epoch: 1, deep: null, fine: { columns: [], columnMs: 10 * S } };
  const closing = (ts: number, high: number, low: number, close: number): BarFrame => ({ ...bar(ts, high, low), close });

  it("is the verdict itself on a complete window, and nothing while the window is open", () => {
    const feed = feedOf(() => wall());
    expect(readWindow(feed, 1, [], HIGH, "high", RULES, T0, END)).toMatchObject({ verdict: "held", best: "held" });
    expect(readWindow(feed, 1, [], HIGH, "high", RULES, T0, T0 + MINUTE)).toMatchObject({ open: true, verdict: null, best: null });
    expect(readWindow(empty, 1, [bar(T0, 105, 98)], HIGH, "high", RULES, T0, T0 + MINUTE)).toMatchObject({ open: true, noBook: true, best: null });
  });

  it("judges a window with a hole, thin coverage or a late book from the columns it has, while its verdict stays undecided", () => {
    const full = feedOf(() => wall());
    const gapped: ColumnFeed = { ...full, fine: { ...full.fine, columns: full.fine.columns.filter((column) => column.ts < T0 + MINUTE || column.ts >= T0 + 3 * MINUTE) } };
    expect(readWindow(gapped, 1, [], HIGH, "high", RULES, T0, END)).toMatchObject({ partial: true, bookGap: true, verdict: null, best: "held" });
    const breaking = feedOf((i) => ({ ...wall(), buy: [[101, 6]], sell: [[99, 4]], mid: i >= 8 ? 106 : 97 }));
    const candles = Array.from({ length: 5 }, (_, i) => ({ ...bar(T0 + i * MINUTE, 103, 98), volume: 100 }));
    expect(readWindow(breaking, 1, candles, HIGH, "high", RULES, T0, END)).toMatchObject({ partial: true, verdict: null, best: "strongBreak" });
    const late = readWindow(full, 1, [], HIGH, "high", RULES, T0 - 2 * MINUTE, END);
    expect(late).toMatchObject({ noBook: true, verdict: null, best: "held", facts: { before: 200, now: 200 } });
  });

  it("judges a window with no columns from the candles: a break when the last candle closed past the band, a sweep when a wick went past and price came back, held otherwise", () => {
    expect(readWindow(empty, 1, [bar(T0, 105, 98)], HIGH, "high", RULES, T0, END)).toMatchObject({ noBook: true, verdict: null, best: "swept", facts: { wentPast: true, outAtEnd: false } });
    expect(readWindow(empty, 1, [closing(T0, 110, 99, 108)], HIGH, "high", RULES, T0, END)).toMatchObject({ noBook: true, verdict: null, best: "weakBreak", facts: { outAtEnd: true } });
    expect(readWindow(empty, 1, [closing(T0, 110, 99, 104)], HIGH, "high", RULES, T0, END)).toMatchObject({ best: "swept", facts: { outAtEnd: false } });
    expect(readWindow(empty, 1, [bar(T0, 102, 98)], HIGH, "high", RULES, T0, END)).toMatchObject({ best: "held", facts: { wentPast: false, outAtEnd: false } });
    expect(readWindow(empty, 1, [closing(T0, 110, 99, 108), bar(T0 + 4 * MINUTE, 103, 98)], HIGH, "high", RULES, T0, END)).toMatchObject({ best: "swept", facts: { outAtEnd: false } });
    expect(readWindow(empty, 1, [bar(T0, 103, 98), closing(T0 + 5 * MINUTE, 110, 99, 108)], HIGH, "high", RULES, T0, END)).toMatchObject({ best: "held" });
    expect(readWindow(empty, 1, [closing(T0, 99, 80, 85)], 90, "low", RULES, T0, END)).toMatchObject({ best: "weakBreak" });
    // With columns, the book's own mid says where price ended, not the candle's close.
    const inside = feedOf(() => wall());
    expect(readWindow(inside, 1, [closing(T0, 110, 99, 108)], HIGH, "high", RULES, T0, END)).toMatchObject({ verdict: "swept", facts: { outAtEnd: false } });
  });
});
