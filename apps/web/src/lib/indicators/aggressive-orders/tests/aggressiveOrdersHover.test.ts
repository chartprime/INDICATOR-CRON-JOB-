import { describe, expect, it } from "vitest";
import { describeBubble, sizeUnitFor } from "../aggressiveOrdersHover";

const T = 1_700_000_000_000;

describe("aggressiveOrdersHover", () => {
  it("names the unit a bubble's size is counted in: the coin on Binance, contracts on a future, shares on an equity", () => {
    expect(sizeUnitFor({ provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT" })).toBe("BTC");
    expect(sizeUnitFor({ provider: "BINANCE", marketKind: "SPOT", symbol: "ETH-USDT" })).toBe("ETH");
    expect(sizeUnitFor({ provider: "DXFEED", assetClass: "FUTURE", symbol: "/NQZ26:XCME" })).toBe("contracts");
    expect(sizeUnitFor({ provider: "DXFEED", assetClass: "EQUITY", symbol: "NVDA" })).toBe("shares");
  });

  it("says what happened at the bubble: the side, the size in its unit, the prints and where they filled", () => {
    expect(describeBubble({ side: "buy", volume: 12.4, price: 78_201.5, ts: T, count: 3 }, "BTC")).toEqual({
      side: "buy",
      title: "Buy",
      size: "12.4 BTC",
      detail: "3 prints at 78,201.5",
    });
    expect(describeBubble({ side: "sell", volume: 38, price: 24_812.25, ts: T, count: 1 }, "contracts")).toEqual({
      side: "sell",
      title: "Sell",
      size: "38 contracts",
      detail: "1 print at 24,812.25",
    });
    expect(describeBubble({ side: "buy", volume: 12_500, price: 181.2, ts: T, count: 40 }, "shares").size).toBe("12.5k shares");
    expect(describeBubble({ side: "buy", volume: 0.4237, price: 3_000, ts: T, count: 1 }, "ETH").size).toBe("0.42 ETH");
    expect(describeBubble({ side: "buy", volume: 5, price: 100, ts: T, count: 1 }, "").size).toBe("5.00");
  });
});
