import { describe, expect, it } from "vitest";
import type { ColumnFeed } from "../../absorption-detector/absorptionColumns";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import type { LiquidityPrint } from "../../../../types/frames";
import { describeRangeStats, readRangeStats } from "../rangeStats";

const T0 = 1_700_000_000_000;
const S = 1_000;

function column(ts: number, buy: (readonly [number, number])[] = [], sell: (readonly [number, number])[] = [], prints: LiquidityPrint[] = []): LiquidityColumn {
  return { ts, lo: 90, hi: 110, bid: new Float64Array(21), ask: new Float64Array(21), buy, sell, prints };
}

function fill(ts: number, side: "buy" | "sell", size: number, price = 100): LiquidityPrint {
  return { ts, price, size, side, id: null };
}

function feedOf(columns: LiquidityColumn[], deep: LiquidityColumn[] = []): ColumnFeed {
  return { epoch: 1, deep: deep.length > 0 ? { columns: deep, columnMs: 10 * S } : null, fine: { columns, columnMs: S } };
}

describe("readRangeStats", () => {
  it("sums what was bought and sold over the range's columns, and takes the biggest market order on each side from the fills, not from a row's total", () => {
    const feed = feedOf([
      column(T0, [[100, 3], [101, 12]], [[99, 5]], [fill(T0 - 400, "buy", 3), fill(T0 - 200, "buy", 7), fill(T0 - 200, "sell", 5)]),
      column(T0 + S, [[100, 7]], [[98, 40], [99, 1]], [fill(T0 + 600, "buy", 7), fill(T0 + 700, "sell", 12), fill(T0 + 800, "sell", 9)]),
      column(T0 + 2 * S, [[102, 2]]),
      column(T0 + 3 * S, [[100, 90]], [[97, 90]], [fill(T0 + 2_500, "buy", 90)]),
    ]);
    expect(readRangeStats(feed, T0, T0 + 3 * S)).toEqual({ biggestBuy: 7, biggestSell: 12, bought: 24, sold: 46 });
  });

  it("counts the fills of one market order together: same side, same millisecond, across prices and across columns", () => {
    const sweep = T0 + 900;
    const feed = feedOf([
      column(T0 + S, [[100, 4], [101, 6]], [], [fill(sweep, "buy", 4, 100), fill(sweep, "buy", 6, 101), fill(sweep, "sell", 2)]),
      column(T0 + 2 * S, [[102, 3]], [], [fill(sweep, "buy", 3, 102), fill(T0 + 1_500, "buy", 8)]),
    ]);
    expect(readRangeStats(feed, T0, T0 + 3 * S)).toMatchObject({ biggestBuy: 13, biggestSell: 2 });
  });

  it("reads the deep tier behind the fine one, and reads nothing as no stats", () => {
    const deep = [column(T0 - 30 * S, [[100, 20]], [[99, 30]], [fill(T0 - 35 * S, "buy", 20), fill(T0 - 32 * S, "sell", 30)]), column(T0 - 20 * S, [[100, 5]]), column(T0 - 10 * S)];
    const feed = feedOf([column(T0, [[100, 1]], [], [fill(T0 - 500, "buy", 1)])], deep);
    expect(readRangeStats(feed, T0 - 30 * S, T0 + S)).toEqual({ biggestBuy: 20, biggestSell: 30, bought: 26, sold: 30 });
    expect(readRangeStats(feed, T0 + 60 * S, T0 + 120 * S)).toBeNull();
  });

  it("reads a range whose start is older than the oldest column as no stats, not as the part the book still holds", () => {
    const deep = [column(T0 + 2_400 * S, [[100, 50]], [[99, 10]], [fill(T0 + 2_395 * S, "buy", 50)]), column(T0 + 2_410 * S, [[100, 5]])];
    const feed = feedOf([column(T0 + 3_600 * S, [[100, 1]])], deep);
    expect(readRangeStats(feed, T0, T0 + 3_600 * S)).toBeNull();
    expect(readRangeStats(feed, T0 + 2_391 * S, T0 + 3_600 * S)).toBeNull();
    expect(readRangeStats(feed, T0 + 2_391 * S, T0 + 2_420 * S)).toMatchObject({ bought: 55, sold: 10 });
    const lateStart = feedOf([5, 6, 7, 8, 9].map((second) => column(T0 + second * S, [[100, 1]])));
    expect(readRangeStats(lateStart, T0, T0 + 10 * S)).toBeNull();
    expect(readRangeStats(lateStart, T0 + 5 * S, T0 + 10 * S)).toMatchObject({ bought: 5 });
  });

  it("reads no market order as none, when the columns kept no fills", () => {
    expect(readRangeStats(feedOf([column(T0, [[100, 5]], [[99, 5]])]), T0, T0 + S)).toEqual({ biggestBuy: 0, biggestSell: 0, bought: 5, sold: 5 });
  });

  it("does not cache incomplete range totals when the book stops before the end or has an interior gap", () => {
    expect(readRangeStats(feedOf([column(T0, [[100, 5]])]), T0, T0 + 3 * S)).toBeNull();
    expect(readRangeStats(feedOf([column(T0, [[100, 5]]), column(T0 + 2 * S, [[100, 7]])]), T0, T0 + 3 * S)).toBeNull();
  });
});

describe("describeRangeStats", () => {
  it("writes the four lines the trader asked for, the CVD with its sign, and says so when there is no book", () => {
    expect(describeRangeStats({ biggestBuy: 12, biggestSell: 40.25, bought: 1250, sold: 1500 }, "BTC")).toEqual([
      "Biggest market buy: 12.0 BTC",
      "Biggest market sell: 40.3 BTC",
      "Total traded: 2.8k BTC",
      "CVD: -250 BTC",
    ]);
    expect(describeRangeStats({ biggestBuy: 0, biggestSell: 0, bought: 30, sold: 10 }, "contracts")[3]).toBe("CVD: +20.0 contracts");
    expect(describeRangeStats(null, "BTC")).toEqual(["no book for this range"]);
  });
});

describe("describeRangeStats for totals read from the host", () => {
  it("leaves out the biggest orders when the columns carried no prints, and keeps them otherwise", () => {
    expect(describeRangeStats({ biggestBuy: 0, biggestSell: 0, bought: 30, sold: 10, noPrints: true }, "BTC")).toEqual(["Total traded: 40.0 BTC", "CVD: +20.0 BTC"]);
    expect(describeRangeStats({ biggestBuy: 0, biggestSell: 0, bought: 30, sold: 10 }, "BTC")).toEqual(["Biggest market buy: 0 BTC", "Biggest market sell: 0 BTC", "Total traded: 40.0 BTC", "CVD: +20.0 BTC"]);
  });
});

describe("describeRangeStats for totals read around a hole", () => {
  it("says how many minutes of book are missing, at least one", () => {
    expect(describeRangeStats({ biggestBuy: 0, biggestSell: 0, bought: 30, sold: 10, noPrints: true, missingMs: 600_000 }, "BTC")).toEqual(["Total traded: 40.0 BTC", "CVD: +20.0 BTC", "book missing for 10 min"]);
    expect(describeRangeStats({ biggestBuy: 0, biggestSell: 0, bought: 30, sold: 10, noPrints: true, missingMs: 20_000 }, "BTC").at(-1)).toBe("book missing for 1 min");
    expect(describeRangeStats({ biggestBuy: 0, biggestSell: 0, bought: 30, sold: 10, noPrints: true }, "BTC")).toHaveLength(2);
  });
});
