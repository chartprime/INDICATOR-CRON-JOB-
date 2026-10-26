const { liquidityFrame, dxfeedLiquidityFrame } = require("../../src/server/frames");

const T = 1_800_000_000_000;
const body = () => ({
  ts: T,
  seq: 1,
  reset: true,
  rowWidth: 1.5,
  columnMs: 1000,
  columns: [{ ts: T, lo: 19700, hi: 19702, bid: [[0, 3], [1, 12]], ask: [[2, 7]] }],
});

describe("dxfeedLiquidityFrame", () => {
  it("carries the dxFeed identity with the same body as the Binance frame", () => {
    const frame = dxfeedLiquidityFrame("/NQZ26:XCME", "FUTURE", body());
    expect(frame).toMatchObject({
      type: "liquidity",
      provider: "DXFEED",
      symbol: "/NQZ26:XCME",
      assetClass: "FUTURE",
      ts: T,
      seq: 1,
      reset: true,
      row_width: 1.5,
      column_ms: 1000,
    });
    expect(Object.hasOwn(frame, "marketKind")).toBe(false);
    expect(frame.columns).toEqual([{ ts: T, lo: 19700, hi: 19702, bid: [[0, 3], [1, 12]], ask: [[2, 7]] }]);
    expect(Object.isFrozen(frame)).toBe(true);
    // The Binance frame is unchanged.
    const binance = liquidityFrame("BTCUSDT", "SPOT", body());
    expect(binance).toMatchObject({ provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT", row_width: 1.5 });
    expect(Object.hasOwn(binance, "assetClass")).toBe(false);
    expect(binance.columns).toEqual(frame.columns);
  });

  it("rejects an unknown asset class or symbol, and still validates the body", () => {
    expect(() => dxfeedLiquidityFrame("/NQZ26:XCME", "SPOT", body())).toThrow(/assetClass/);
    expect(() => dxfeedLiquidityFrame("NOPE", "EQUITY", body())).toThrow(/unsupported symbol/);
    expect(() => dxfeedLiquidityFrame("AAPL", "EQUITY", { ...body(), seq: -1 })).toThrow(/seq/);
    expect(() => dxfeedLiquidityFrame("AAPL", "EQUITY", { ...body(), columns: [] , reset: false })).toThrow(/columns/);
  });
});
