"use strict";

const { candleMonitorFrame, MAX_CANDLE_MONITOR_ENTRIES, CANDLE_MONITOR_ENTRY_KEYS, CANDLE_MONITOR_TRADE_KEYS } = require("../../src/server/candle-monitor-frames");
const { frameKindOf, FRAME_KIND_LATEST_STATE } = require("../../src/server/frames");
const { CANDLE_MS, RAW_CAP } = require("../../src/indicators/exhaustion/exhaustion-engine");

const binance = { provider: "BINANCE", symbol: "BTCUSDT", marketKind: "PERPETUAL" };
const dxfeed = { provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" };

function entry(overrides = {}) {
  return { candleMs: 60_000, candleTs: 1_700_000_220_000, buy: 2.97, sell: 0.56, biggestBuy: { price: 31_190, size: 1.21 }, biggestSell: { price: 31_186.5, size: 0.4 }, ...overrides };
}

describe("server/candle-monitor-frames", () => {
  test("a frame carries the identity, a timestamp and one entry per candle length in rising order, frozen, latest-state", () => {
    const frame = candleMonitorFrame(dxfeed, { ts: 10_000, entries: [entry(), entry({ candleMs: 300_000, candleTs: 1_700_000_100_000, biggestBuy: null, biggestSell: null })] });
    expect(frame).toEqual({ type: "candle_monitor", provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE", ts: 10_000, entries: [entry(), entry({ candleMs: 300_000, candleTs: 1_700_000_100_000, biggestBuy: null, biggestSell: null })] });
    expect(Object.isFrozen(frame) && Object.isFrozen(frame.entries) && Object.isFrozen(frame.entries[0]) && Object.isFrozen(frame.entries[0].biggestBuy)).toBe(true);
    expect(frameKindOf(frame)).toBe(FRAME_KIND_LATEST_STATE);
    expect(candleMonitorFrame(binance, { ts: 10_000, entries: [entry({ buy: 0, sell: 0 })] })).toMatchObject({ provider: "BINANCE", symbol: "BTC-USDT", marketKind: "PERPETUAL" });
    expect(MAX_CANDLE_MONITOR_ENTRIES).toBe(CANDLE_MS.length);
    expect(CANDLE_MONITOR_ENTRY_KEYS).toEqual(["candleMs", "candleTs", "buy", "sell", "biggestBuy", "biggestSell"]);
    expect(CANDLE_MONITOR_TRADE_KEYS).toEqual(["price", "size"]);
  });

  test("refuses no entries, too many, a repeated or falling candle length, a candle not opening on its length, and a bad field", () => {
    expect(() => candleMonitorFrame(dxfeed, { ts: 10_000, entries: [] })).toThrow(new RegExp(`one to ${MAX_CANDLE_MONITOR_ENTRIES} entries`));
    expect(() => candleMonitorFrame(dxfeed, { ts: 10_000, entries: Array.from({ length: MAX_CANDLE_MONITOR_ENTRIES + 1 }, () => entry()) })).toThrow(new RegExp(`one to ${MAX_CANDLE_MONITOR_ENTRIES} entries`));
    expect(() => candleMonitorFrame(dxfeed, { ts: 10_000, entries: [entry(), entry()] })).toThrow(/rise by candle length/);
    expect(() => candleMonitorFrame(dxfeed, { ts: 10_000, entries: [entry({ candleMs: 300_000, candleTs: 1_700_000_100_000 }), entry()] })).toThrow(/rise by candle length/);
    expect(() => candleMonitorFrame(dxfeed, { ts: 10_000, entries: [entry({ candleMs: 300_000 })] })).toThrow(/open on its candle length/);
    expect(() => candleMonitorFrame(dxfeed, { ts: -1, entries: [entry()] })).toThrow(/ts/);
    expect(() => candleMonitorFrame({ provider: "X" }, { ts: 1, entries: [entry()] })).toThrow(/provider/);
    for (const [overrides, pattern] of [
      [{ candleMs: 240_000 }, /candleMs/], [{ candleTs: 1.5 }, /candleTs/], [{ buy: -1 }, /buy/], [{ buy: RAW_CAP + 1 }, /buy/], [{ sell: NaN }, /sell/], [{ sell: "1" }, /sell/],
      [{ biggestBuy: { price: 1 } }, /biggestBuy/], [{ biggestBuy: { price: 1, qty: 1 } }, /exactly price and size/], [{ biggestBuy: { price: 0, size: 1 } }, /biggestBuy\.price/], [{ biggestSell: { price: 1, size: 0 } }, /biggestSell\.size/],
      [{ biggestSell: { price: 1, size: 1, extra: 1 } }, /biggestSell/], [{ biggestBuy: [1, 2] }, /biggestBuy/], [{ biggestBuy: undefined }, /biggestBuy/], [{ extra: 1 }, /exactly/],
    ]) {
      expect(() => candleMonitorFrame(dxfeed, { ts: 10_000, entries: [entry(overrides)] })).toThrow(pattern);
    }
    expect(() => candleMonitorFrame(dxfeed, { ts: 10_000, entries: [null] })).toThrow(/object/);
  });
});
