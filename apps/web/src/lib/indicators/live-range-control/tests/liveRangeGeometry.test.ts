import { describe, expect, it } from "vitest";
import { DEFAULT_CANDLE_MS, LINE_HIT_PX, candleMsOf, logicalOfTime, logicalOfX, nearestLine, timeOfLogical, tradedSpans, xOfLogical, type LogicalScale, type WindowLines } from "../liveRangeGeometry";

const T = Date.UTC(2026, 9, 16, 2, 0);
const MINUTE = 60_000;

function rows(times: number[]): { time: number }[] {
  return times.map((ms) => ({ time: ms / 1_000 }));
}

const ROWS = rows([T, T + MINUTE, T + 2 * MINUTE, T + 3 * MINUTE]);

describe("tradedSpans", () => {
  it("is the candles' time inside a range, candles that touch joined, so a stretch with no candle, a closed market, is left out", () => {
    const bars = rows([T, T + MINUTE, T + 2 * MINUTE, T + 10 * MINUTE, T + 11 * MINUTE]);
    expect(tradedSpans(bars, MINUTE, T + 30_000, T + 11 * MINUTE + 40_000)).toEqual([[T + 30_000, T + 3 * MINUTE], [T + 10 * MINUTE, T + 11 * MINUTE + 40_000]]);
    expect(tradedSpans(bars, MINUTE, T + 4 * MINUTE, T + 9 * MINUTE)).toEqual([]);
    expect(tradedSpans(bars, MINUTE, T + 2 * MINUTE + 30_000, T + 10 * MINUTE + 1)).toEqual([[T + 2 * MINUTE + 30_000, T + 3 * MINUTE], [T + 10 * MINUTE, T + 10 * MINUTE + 1]]);
    expect(tradedSpans(bars, MINUTE, T + MINUTE, T + MINUTE)).toEqual([]);
    expect(tradedSpans(bars, MINUTE, T + 30_000, T + 20_000)).toEqual([]);
    expect(tradedSpans([], MINUTE, T, T + MINUTE)).toEqual([]);
    expect(tradedSpans(bars, 5 * MINUTE, T, T + 20 * MINUTE)).toEqual([[T, T + 7 * MINUTE], [T + 10 * MINUTE, T + 16 * MINUTE]]);
  });
});

describe("candleMsOf", () => {
  it("takes the length of a candle from the last two rows, and a minute without two rows in order", () => {
    expect(candleMsOf(ROWS)).toBe(MINUTE);
    expect(candleMsOf(rows([T, T + 5 * MINUTE]))).toBe(5 * MINUTE);
    expect(candleMsOf(rows([T, T + 5 * MINUTE, T + 6 * MINUTE]))).toBe(MINUTE);
    expect(candleMsOf(rows([T]))).toBe(DEFAULT_CANDLE_MS);
    expect(candleMsOf([])).toBe(DEFAULT_CANDLE_MS);
    expect(candleMsOf(rows([T + MINUTE, T]))).toBe(DEFAULT_CANDLE_MS);
    expect(candleMsOf(rows([T, T]))).toBe(DEFAULT_CANDLE_MS);
    expect(DEFAULT_CANDLE_MS).toBe(60_000);
  });
});

describe("logicalOfTime", () => {
  it("puts the open of a candle on its left edge and the moments in it across its width", () => {
    expect(logicalOfTime(ROWS, T, MINUTE)).toBe(-0.5);
    expect(logicalOfTime(ROWS, T + 30_000, MINUTE)).toBe(0);
    expect(logicalOfTime(ROWS, T + 2 * MINUTE + 15_000, MINUTE)).toBe(1.75);
    expect(logicalOfTime(ROWS, T + 3 * MINUTE, MINUTE)).toBe(2.5);
  });

  it("runs on past the last candle and back before the first at the length of a candle", () => {
    expect(logicalOfTime(ROWS, T + 3 * MINUTE + 30_000, MINUTE)).toBe(3);
    expect(logicalOfTime(ROWS, T + 5 * MINUTE, MINUTE)).toBe(4.5);
    expect(logicalOfTime(ROWS, T - MINUTE, MINUTE)).toBe(-1.5);
    expect(logicalOfTime(ROWS, T - 30_000, MINUTE)).toBe(-1);
  });

  it("keeps a moment in a gap between candles at the right edge of the candle before the gap", () => {
    const gapped = rows([T, T + MINUTE, T + 61 * MINUTE]);
    expect(logicalOfTime(gapped, T + MINUTE + 30_000, MINUTE)).toBe(1);
    expect(logicalOfTime(gapped, T + 30 * MINUTE, MINUTE)).toBe(1.5);
    expect(logicalOfTime(gapped, T + 61 * MINUTE, MINUTE)).toBe(1.5);
  });

  it("has no place without candles, a candle length or a moment", () => {
    expect(logicalOfTime([], T, MINUTE)).toBeNull();
    expect(logicalOfTime(ROWS, T, 0)).toBeNull();
    expect(logicalOfTime(ROWS, Number.NaN, MINUTE)).toBeNull();
  });
});

describe("timeOfLogical", () => {
  it("reads a place on the chart back as the moment it shows", () => {
    expect(timeOfLogical(ROWS, -0.5, MINUTE)).toBe(T);
    expect(timeOfLogical(ROWS, 0, MINUTE)).toBe(T + 30_000);
    expect(timeOfLogical(ROWS, 1.75, MINUTE)).toBe(T + 2 * MINUTE + 15_000);
    expect(timeOfLogical(ROWS, 2.5, MINUTE)).toBe(T + 3 * MINUTE);
    expect(timeOfLogical(ROWS, 4.5, MINUTE)).toBe(T + 5 * MINUTE);
    expect(timeOfLogical(ROWS, -1.5, MINUTE)).toBe(T - MINUTE);
  });

  it("reads a place right of the middle of a gap as the candle after it, and left of it as the candle before", () => {
    const gapped = rows([T, T + MINUTE, T + 61 * MINUTE]);
    expect(timeOfLogical(gapped, 1.75, MINUTE)).toBe(T + 61 * MINUTE + 15_000);
    expect(timeOfLogical(gapped, 1.25, MINUTE)).toBe(T + MINUTE + 45_000);
  });

  it("undoes logicalOfTime over the candles and on either side of them", () => {
    for (const ms of [T, T + 10_000, T + MINUTE + 59_000, T + 3 * MINUTE + 45_000, T - 2 * MINUTE, T + 7 * MINUTE]) {
      expect(timeOfLogical(ROWS, logicalOfTime(ROWS, ms, MINUTE)!, MINUTE)).toBeCloseTo(ms, 6);
    }
  });

  it("has no moment without candles, a candle length or a place", () => {
    expect(timeOfLogical([], 0, MINUTE)).toBeNull();
    expect(timeOfLogical(ROWS, 0, 0)).toBeNull();
    expect(timeOfLogical(ROWS, Number.NaN, MINUTE)).toBeNull();
  });
});

describe("xOfLogical and logicalOfX", () => {
  const scale: LogicalScale = { logicalToCoordinate: (logical) => (Number.isInteger(logical) ? 7 + logical * 12 : 0) };

  it("places a place between candles from the spacing of two whole candles, as the chart places only whole ones", () => {
    expect(xOfLogical(scale, 3)).toBe(43);
    expect(xOfLogical(scale, 2.5)).toBe(37);
    expect(xOfLogical(scale, 2.25)).toBe(34);
    expect(xOfLogical(scale, -1.5)).toBe(-11);
    expect(xOfLogical(scale, Number.NaN)).toBeNull();
    expect(xOfLogical({ logicalToCoordinate: () => null }, 2.5)).toBeNull();
    expect(xOfLogical({ logicalToCoordinate: (logical) => (logical === 0 ? 5 : null) }, 2.5)).toBeNull();
    expect(xOfLogical({ logicalToCoordinate: (logical) => (logical === 1 ? 5 : null) }, 2.5)).toBeNull();
  });

  it("reads a pixel back as its place between candles from the same two whole candles", () => {
    expect(logicalOfX(scale, 43)).toBe(3);
    expect(logicalOfX(scale, 37)).toBe(2.5);
    expect(logicalOfX(scale, 34)).toBe(2.25);
    expect(logicalOfX(scale, -11)).toBe(-1.5);
    expect(logicalOfX({ logicalToCoordinate: () => null }, 37)).toBeNull();
    expect(logicalOfX({ logicalToCoordinate: (logical) => (logical === 0 ? 5 : null) }, 37)).toBeNull();
    expect(logicalOfX({ logicalToCoordinate: (logical) => (logical === 0 ? -5 : null) }, 37)).toBeNull();
    expect(logicalOfX({ logicalToCoordinate: () => 5 }, 37)).toBeNull();
    expect(logicalOfX({ logicalToCoordinate: (logical) => 50 - logical * 10 }, 37)).toBeNull();
  });
});

describe("nearestLine", () => {
  const lines: WindowLines = { left: 100, right: 300, from: 100, to: 300 };

  it("finds the line within the hit distance of the pointer, and none farther", () => {
    expect(LINE_HIT_PX).toBe(6);
    expect(nearestLine(lines, 100)).toBe("from");
    expect(nearestLine(lines, 106)).toBe("from");
    expect(nearestLine(lines, 94)).toBe("from");
    expect(nearestLine(lines, 107)).toBeNull();
    expect(nearestLine(lines, 293.5)).toBeNull();
    expect(nearestLine(lines, 294)).toBe("to");
    expect(nearestLine(lines, 306)).toBe("to");
    expect(nearestLine(lines, 200)).toBeNull();
    expect(nearestLine(lines, 110, 10)).toBe("from");
  });

  it("takes the end line right of the middle and the start line left of it when both are near", () => {
    const close: WindowLines = { left: 100, right: 104, from: 100, to: 104 };
    expect(nearestLine(close, 101)).toBe("from");
    expect(nearestLine(close, 102)).toBe("to");
    expect(nearestLine(close, 103)).toBe("to");
    const same: WindowLines = { left: 100, right: 100, from: 100, to: 100 };
    expect(nearestLine(same, 99)).toBe("from");
    expect(nearestLine(same, 100)).toBe("to");
  });

  it("finds only the lines that are drawn, and nothing without lines", () => {
    const live: WindowLines = { left: 100, right: 300, from: 100, to: null };
    expect(nearestLine(live, 300)).toBeNull();
    expect(nearestLine(live, 101)).toBe("from");
    expect(nearestLine({ left: 100, right: 300, from: null, to: 300 }, 300)).toBe("to");
    expect(nearestLine({ left: 100, right: 300, from: null, to: 300 }, 100)).toBeNull();
    expect(nearestLine(null, 100)).toBeNull();
  });
});
