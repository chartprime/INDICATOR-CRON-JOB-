import { describe, expect, it } from "vitest";
import type { CandleMonitorEntry } from "../../../../types/frames";
import { DELTA_DOWN_COLOR, DELTA_UP_COLOR, MONITOR_STALE_MS, candleHeaderText, candleLengthLabel, candleMonitorRows, candleOverdue, candleOverdueAt, candleTimeText, monitorStale, tradeText } from "../candleMonitorText";

const ENTRY: CandleMonitorEntry = { candleMs: 60_000, candleTs: Date.UTC(2026, 9, 11, 14, 59), buy: 2.97, sell: 0.56, biggestBuy: { price: 83_180, size: 1.21 }, biggestSell: { price: 83_120, size: 0.4 } };
const twoPlaces = (price: number) => price.toFixed(2);

describe("candle monitor text", () => {
  it("names the candle by its length and its open in UTC, the date for daily candles, matching the chart's axis", () => {
    expect(candleHeaderText(ENTRY)).toBe("1m · 14:59");
    expect(candleHeaderText({ candleMs: 86_400_000, candleTs: Date.UTC(2026, 9, 11) })).toBe("1D · 11 Oct");
    expect(candleHeaderText({ candleMs: 14_400_000, candleTs: Date.UTC(2026, 0, 3, 4, 0) })).toBe("4h · 04:00");
    expect([60_000, 120_000, 180_000, 300_000, 900_000, 1_800_000, 3_600_000, 14_400_000, 21_600_000, 43_200_000, 86_400_000].map(candleLengthLabel)).toEqual(["1m", "2m", "3m", "5m", "15m", "30m", "1h", "4h", "6h", "12h", "1D"]);
    expect(candleLengthLabel(600_000)).toBe("10m");
    expect(candleTimeText(Date.UTC(2026, 11, 31, 23, 5), 60_000)).toBe("23:05");
  });

  it("the five rows: buys and sells in the unit, the delta signed with its share and coloured by its sign, and each side's biggest trade as size at price", () => {
    expect(candleMonitorRows(ENTRY, "BTC", twoPlaces)).toEqual([
      { key: "buy", label: "Buying volume", value: "2.97 BTC", color: null },
      { key: "sell", label: "Selling volume", value: "0.56 BTC", color: null },
      { key: "delta", label: "Delta", value: "+2.41 (+68%)", color: DELTA_UP_COLOR },
      { key: "biggestBuy", label: "Biggest buyer", value: "1.21 BTC @ 83180.00", color: null },
      { key: "biggestSell", label: "Biggest seller", value: "0.40 BTC @ 83120.00", color: null },
    ]);
    const sellers = candleMonitorRows({ ...ENTRY, buy: 120, sell: 350, biggestBuy: null, biggestSell: { price: 24_120.25, size: 35 } }, "contracts", twoPlaces);
    expect(sellers.map((row) => row.value)).toEqual(["120 contracts", "350 contracts", "−230 (−49%)", "—", "35 contracts @ 24120.25"]);
    expect(sellers[2].color).toBe(DELTA_DOWN_COLOR);
    const flat = candleMonitorRows({ ...ENTRY, buy: 0, sell: 0 }, "", twoPlaces);
    expect(flat.slice(0, 3).map((row) => [row.value, row.color])).toEqual([["0", null], ["0", null], ["0", null]]);
    expect([DELTA_UP_COLOR, DELTA_DOWN_COLOR]).toEqual(["#4ade80", "#f87171"]);
  });

  it("a trade reads as its size in the unit at the price the chart's own formatter writes, never rounded to a whole number; sizes step to k and M", () => {
    expect(tradeText({ price: 83_150.004, size: 412_345 }, "BTC", twoPlaces)).toBe("412k BTC @ 83150.00");
    expect(tradeText({ price: 31_188.25, size: 1_250_000 }, "shares", twoPlaces)).toBe("1.3M shares @ 31188.25");
    expect(tradeText({ price: 230.47, size: 500 }, "shares", twoPlaces)).toBe("500 shares @ 230.47");
    expect(tradeText({ price: 20_123.75, size: 12 }, "contracts", twoPlaces)).toBe("12 contracts @ 20123.75");
    expect(tradeText({ price: 5_800.25, size: 3 }, "contracts", (price) => price.toFixed(4))).toBe("3 contracts @ 5800.2500");
    expect(tradeText({ price: 0.5, size: 3 }, "", twoPlaces)).toBe("3.00 @ 0.50");
    expect(tradeText(null, "BTC", twoPlaces)).toBe("—");
  });

  it("the feed is stale fifteen seconds after the last frame reached the tab, or when none has", () => {
    expect(MONITOR_STALE_MS).toBe(15_000);
    expect(monitorStale(null, 1_000)).toBe(true);
    expect(monitorStale(1_000, 1_000 + MONITOR_STALE_MS)).toBe(false);
    expect(monitorStale(1_000, 1_000 + MONITOR_STALE_MS + 1)).toBe(true);
  });

  it("a candle is overdue once the runtime's own clock passes the close of the candle after it, with fifteen seconds of grace: a stuck tier is not a quiet market", () => {
    const minute = { candleMs: 60_000, candleTs: 1_000_000 } as const;
    expect(candleOverdueAt(minute)).toBe(1_000_000 + 2 * 60_000 + MONITOR_STALE_MS);
    expect(candleOverdue(minute, 1_000_000 + 2 * 60_000 + MONITOR_STALE_MS)).toBe(false);
    expect(candleOverdue(minute, 1_000_000 + 2 * 60_000 + MONITOR_STALE_MS + 1)).toBe(true);
    const day = { candleMs: 86_400_000, candleTs: 1_000_000 } as const;
    expect(candleOverdue(day, 1_000_000 + 2 * 86_400_000 + MONITOR_STALE_MS)).toBe(false);
    expect(candleOverdue(day, 1_000_000 + 2 * 86_400_000 + MONITOR_STALE_MS + 1)).toBe(true);
    expect(candleOverdue(null, Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});
