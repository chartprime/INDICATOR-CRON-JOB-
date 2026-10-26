import { describe, expect, it } from "vitest";
import type { ColumnFeed } from "../../absorption-detector/absorptionColumns";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import type { LevelRules } from "../levelReader";
import { levelWant, rangeWant, readLevelRecording, readRangeRecording } from "../levelRecording";
import { WINDOW_MS, readWindow } from "../levelWindow";
import type { Level } from "../sessionLevelsRules";
import type { OpeningRange } from "../sessionRanges";

const T0 = 1_700_000_100_000;
const S = 1_000;
const MINUTE = 60 * S;
const RULES: LevelRules = { bandRows: 4, floor: 75, share: 2 };
const range: OpeningRange = { kind: "orb", sessionId: "nyam", windowMin: 5, startMs: T0 - 5 * MINUTE, endMs: T0 - MINUTE, high: 100, low: 90, highTouchMs: T0, lowTouchMs: null };
const HIGH: Level = { range, side: "high", price: 100, touchMs: T0 };
const LOW: Level = { range, side: "low", price: 90, touchMs: null };

function recorded(count = 37): ColumnFeed {
  const columns: LiquidityColumn[] = [];
  for (let i = 0; i < count; i += 1) {
    const mid = i >= 2 && i < 20 ? 100 : 97;
    const ask = new Float64Array(51);
    const bid = new Float64Array(51);
    bid[mid - 80] = 5;
    ask[mid + 1 - 80] = 40;
    ask[101 - 80] = 40;
    columns.push({ ts: T0 + i * 10 * S, lo: 80, hi: 130, ask, bid, buy: i === 3 ? [[100, 100]] : [], sell: [] });
  }
  return { epoch: 1, deep: null, fine: { columns, columnMs: 10 * S } };
}

describe("a level's window asked from the host's columns", () => {
  it("asks from the touching bar to five minutes past its end, over the level's wall and attack rows, book kept to the mid", () => {
    expect(levelWant(LOW, MINUTE, 1, 4)).toBeNull();
    expect(levelWant(HIGH, MINUTE, 0, 4)).toBeNull();
    expect(levelWant(HIGH, MINUTE, 1, 4)).toEqual({ key: `level:${T0}:${T0 + MINUTE + WINDOW_MS}:96:105`, fromTs: T0, toTs: T0 + MINUTE + WINDOW_MS, priceLo: 96, priceHi: 105, columnMs: 10_000, reach: "mid" });
    expect(levelWant({ ...LOW, touchMs: T0 + MINUTE }, 5 * MINUTE, 0.25, 4)).toMatchObject({ fromTs: T0 + MINUTE, toTs: T0 + 6 * MINUTE + WINDOW_MS, priceLo: 89, priceHi: 91.25, reach: "mid" });
    expect(levelWant(HIGH, MINUTE, 1, 4)!.key).not.toBe(levelWant(HIGH, 5 * MINUTE, 1, 4)!.key);
  });

  it("judges the window from the recording with the live rule: the touch where the mid first reaches the band, the same verdict", () => {
    const feed = recorded();
    const reading = readLevelRecording({ feed, rowWidth: 1, gaps: [] }, HIGH, MINUTE, [], RULES)!;
    expect(reading.from).toBe(T0 + 20 * S);
    expect(reading.to).toBe(T0 + 20 * S + WINDOW_MS);
    expect(reading).toMatchObject({ open: false, noBook: false, partial: false, verdict: "absorbed" });
    expect(reading).toEqual(readWindow(feed, 1, [], 100, "high", RULES, T0 + 20 * S, T0 + 360 * S));
    expect(readLevelRecording({ feed, rowWidth: 1, gaps: [] }, LOW, MINUTE, [], RULES)).toBeNull();
  });

  it("leaves a hole in the recording out instead of reading it as an empty book: inside the window it is partial book history with the best verdict from the rest", () => {
    const feed = recorded();
    const read = (from: number, to: number) => readLevelRecording({ feed, rowWidth: 1, gaps: [{ from, to }] }, HIGH, MINUTE, [], RULES)!;
    expect(read(T0 + 100 * S, T0 + 130 * S)).toMatchObject({ open: false, noBook: false, partial: true, bookGap: true, verdict: null, best: "absorbed", from: T0 + 20 * S });
    expect(read(T0 - 10 * S, T0 + 10 * S).verdict).toBe("absorbed");
    expect(read(T0, T0 + 20 * S)).toMatchObject({ from: T0 + 30 * S, verdict: "absorbed" });
    expect(read(T0 + 300 * S, T0 + 360 * S)).toMatchObject({ open: false, partial: true, bookGap: true, verdict: null, best: "absorbed", facts: { now: 40 } });
    expect(read(T0 + 310 * S, T0 + 360 * S)).toMatchObject({ open: false, verdict: "absorbed" });
    expect(read(T0 - 10 * S, T0 + 360 * S)).toMatchObject({ open: false, noBook: true, verdict: null, best: "held", from: T0 });
  });
});

describe("a range's totals asked from the host's columns", () => {
  const session: OpeningRange = { ...range, startMs: T0, endMs: T0 + 4 * MINUTE, high: 110, low: 95 };

  function minutes(count: number): ColumnFeed {
    const columns: LiquidityColumn[] = [];
    for (let i = 0; i < count; i += 1) columns.push({ ts: T0 + i * MINUTE, lo: 95, hi: 95, bid: new Float64Array(1), ask: new Float64Array(1), buy: i === 0 ? [[100, 30]] : [], sell: i === 1 ? [[99, 10]] : [] });
    return { epoch: 1, deep: null, fine: { columns, columnMs: MINUTE } };
  }

  it("asks the range's own span for the flow alone", () => {
    expect(rangeWant(session, MINUTE)).toEqual({ key: `range:${T0}:${T0 + 5 * MINUTE - 1}`, fromTs: T0, toTs: T0 + 5 * MINUTE - 1, priceLo: 95, priceHi: 110, columnMs: 10_000, reach: "flow" });
    expect(rangeWant({ ...session, high: 95 }, MINUTE)).toMatchObject({ priceLo: 95, priceHi: 96 });
    expect(rangeWant(session, 5 * MINUTE).toTs).toBe(T0 + 9 * MINUTE - 1);
  });

  it("reads the totals from the columns the host holds, without the biggest orders they do not carry, says how much is missing, and reads nothing only when it holds none", () => {
    const totals = { biggestBuy: 0, biggestSell: 0, noPrints: true };
    expect(readRangeRecording({ feed: minutes(5), rowWidth: 1, gaps: [] }, session, MINUTE)).toEqual({ ...totals, bought: 30, sold: 10 });
    expect(readRangeRecording({ feed: minutes(8), rowWidth: 1, gaps: [] }, session, MINUTE)).toEqual({ ...totals, bought: 30, sold: 10 });
    expect(readRangeRecording({ feed: minutes(5), rowWidth: 1, gaps: [{ from: T0 + MINUTE, to: T0 + 3 * MINUTE }] }, session, MINUTE)).toEqual({ ...totals, bought: 30, sold: 10, missingMs: 2 * MINUTE });
    expect(readRangeRecording({ feed: minutes(5), rowWidth: 1, gaps: [{ from: T0 - MINUTE, to: T0 + MINUTE }] }, session, MINUTE)).toEqual({ ...totals, bought: 0, sold: 0, missingMs: 2 * MINUTE });
    expect(readRangeRecording({ feed: minutes(4), rowWidth: 1, gaps: [] }, session, MINUTE)).toEqual({ ...totals, bought: 30, sold: 10, missingMs: MINUTE });
    expect(readRangeRecording({ feed: minutes(5), rowWidth: 1, gaps: [{ from: T0 - MINUTE, to: T0 + 5 * MINUTE }] }, session, MINUTE)).toBeNull();
    expect(readRangeRecording({ feed: minutes(0), rowWidth: 1, gaps: [] }, session, MINUTE)).toBeNull();
    expect(readRangeRecording({ feed: minutes(5), rowWidth: 1, gaps: [] }, { ...session, startMs: T0 + MINUTE }, MINUTE)).toEqual({ ...totals, bought: 0, sold: 10 });
    expect(readRangeRecording({ feed: minutes(5), rowWidth: 1, gaps: [] }, { ...session, endMs: T0 }, MINUTE)).toEqual({ ...totals, bought: 30, sold: 0 });
  });
});
