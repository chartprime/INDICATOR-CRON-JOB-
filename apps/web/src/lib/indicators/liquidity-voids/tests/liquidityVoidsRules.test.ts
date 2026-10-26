import { describe, expect, it } from "vitest";
import { instrumentKey } from "../../../chart/drawingStore";
import { historyHoursOf, DEFAULT_LIQUIDITY_VOIDS_SETTINGS, bubbleSizeFor, isMaxTradedByInstrument, learnedKOf, learnedMaxTradedOf, maxTradedSliderRange, minMoveFor, maxTradedFor, maxTradedOf, minMoveOf, priceUnitFor, sweepRulesFor, thresholdRuleFor, tickSizeFor, timeframeFactor, warmupMsFor, type Identity } from "../liquidityVoidsRules";

const NQ: Identity = { provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" };
const ES: Identity = { provider: "DXFEED", symbol: "/ESZ26:XCME", assetClass: "FUTURE" };
const AAPL: Identity = { provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" };
const BTC: Identity = { provider: "BINANCE", symbol: "BTC-USDT", marketKind: "PERPETUAL" };
const ETH: Identity = { provider: "BINANCE", symbol: "ETH-USDT", marketKind: "SPOT" };

describe("liquidity voids rules", () => {
  it("sets the Zone Width per instrument: BTC 30 USD, ETH 1, NQ 22 ticks, ES 6 ticks, and 2 bp of price elsewhere", () => {
    expect(minMoveFor(NQ, 24_000)).toBe(22);
    expect(minMoveFor(ES, 6_800)).toBe(6);
    expect(minMoveFor(BTC, 110_000)).toBe(30);
    expect(minMoveFor(ETH, 2_700)).toBe(1);
    expect(minMoveFor(AAPL, 250)).toBe(0.05);
  });

  it("turns the sensitivity into the minimum move: High is the instrument's base (30 USD on BTC), Normal 50 and Low 70 in the same proportion, futures in ticks, and anything else reads as Normal, the default", () => {
    expect(DEFAULT_LIQUIDITY_VOIDS_SETTINGS.sensitivity).toBe("normal");
    expect(minMoveOf({ sensitivity: "high" }, BTC, 110_000, 60_000)).toBe(30);
    expect(minMoveOf({ sensitivity: "normal" }, BTC, 110_000, 60_000)).toBe(50);
    expect(minMoveOf({ sensitivity: "low" }, BTC, 110_000, 60_000)).toBe(70);
    expect(minMoveOf({ sensitivity: "sideways" as never }, BTC, 110_000, 60_000)).toBe(50);
    expect(minMoveOf({ sensitivity: "high" }, NQ, 24_000, 60_000)).toBe(5.5);
    expect(minMoveOf({ sensitivity: "low" }, NQ, 24_000, 60_000)).toBeCloseTo((22 * 70) / 30 * 0.25);
    expect(minMoveOf({ sensitivity: "normal" }, ETH, 2_700, 60_000)).toBeCloseTo(50 / 30);
  });

  it("sets the maximum traded per instrument at three Aggressive Orders bubbles, 100 contracts on NQ and 300 on ES, and scales it with the timeframe", () => {
    expect(maxTradedFor(BTC)).toBe(30);
    expect(maxTradedFor({ provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT" })).toBe(6);
    expect(maxTradedFor(ES)).toBe(300);
    expect(maxTradedFor(NQ)).toBe(100);
    expect(maxTradedFor({ provider: "DXFEED", symbol: "/MESZ26:XCME", assetClass: "FUTURE" })).toBe(300);
    expect(maxTradedFor(AAPL)).toBe(3_000);
    expect(maxTradedOf(BTC, 60_000)).toBe(30);
    expect(maxTradedOf(BTC, 5 * 60_000)).toBe(51);
    expect(maxTradedOf(BTC, 3_600_000)).toBeCloseTo(84);
    expect(maxTradedOf(ES, 60_000)).toBe(300);
    expect(maxTradedOf(NQ, 5 * 60_000)).toBe(170);
  });

  it("scales the minimum move with the chart timeframe and keeps rising: x1 on 1m, x1.7 on 5m, x2.2 on 15m, x2.8 on 1h, x3.4 on 4h, x4.1 on 1D", () => {
    expect(timeframeFactor(60_000)).toBe(1);
    expect(timeframeFactor(5 * 60_000)).toBe(1.7);
    expect(timeframeFactor(15 * 60_000)).toBe(2.2);
    expect(timeframeFactor(3_600_000)).toBe(2.8);
    expect(timeframeFactor(4 * 3_600_000)).toBe(3.4);
    expect(timeframeFactor(24 * 3_600_000)).toBe(4.1);
    expect(timeframeFactor(1_000)).toBe(1);
    expect(minMoveOf({ sensitivity: "high" }, BTC, 110_000, 5 * 60_000)).toBe(51);
    expect(minMoveOf({ sensitivity: "low" }, BTC, 110_000, 3_600_000)).toBeCloseTo(196);
  });

  it("knows the tick of a dxFeed instrument from the catalog, and shows crypto in dollars only", () => {
    expect(tickSizeFor(NQ)).toBe(0.25);
    expect(tickSizeFor(ES)).toBe(0.25);
    expect(tickSizeFor(AAPL)).toBe(0.01);
    expect(tickSizeFor(BTC)).toBeNull();
    expect(tickSizeFor(ETH)).toBeNull();
    expect(tickSizeFor({ provider: "DXFEED", symbol: "/YMZ26:XCBT", assetClass: "FUTURE" })).toBeNull();
  });

  it("writes futures moves in points and everything else in dollars", () => {
    expect(priceUnitFor(NQ)).toBe("pts");
    expect(priceUnitFor(AAPL)).toBe("$");
    expect(priceUnitFor(BTC)).toBe("$");
  });

  it("keeps the levels nearest to price unless the trader picks the furthest", () => {
    expect(DEFAULT_LIQUIDITY_VOIDS_SETTINGS.levelsBy).toBe("nearest");
  });

  it("keeps 48 hours of history by default, takes the saved hours up to a week, and reads anything else as the default", () => {
    expect(DEFAULT_LIQUIDITY_VOIDS_SETTINGS.historyHours).toBe(48);
    expect(historyHoursOf(DEFAULT_LIQUIDITY_VOIDS_SETTINGS)).toBe(48);
    expect(historyHoursOf({ historyHours: 12 })).toBe(12);
    expect(historyHoursOf({ historyHours: 0 })).toBe(0);
    expect(historyHoursOf({ historyHours: 500 })).toBe(168);
    expect(historyHoursOf({ historyHours: -3 })).toBe(48);
    expect(historyHoursOf({ historyHours: Number.NaN })).toBe(48);
    expect(historyHoursOf(undefined)).toBe(48);
  });

  it("reads the thresholds choice per market: Learned by default on NQ and ES, Fixed elsewhere, each market's own choice honoured; the slider's number is the maximum under Learned, scaled with the timeframe; turns Sensitivity into the learned multiple 1 / 1.25 / 1.5, and asks four times the warm-up for a stock, whose session is a quarter of the clock", () => {
    expect([DEFAULT_LIQUIDITY_VOIDS_SETTINGS.thresholdsIndex, DEFAULT_LIQUIDITY_VOIDS_SETTINGS.thresholdsOther]).toEqual(["learned", "fixed"]);
    expect([BTC, ETH, AAPL].map((identity) => thresholdRuleFor(DEFAULT_LIQUIDITY_VOIDS_SETTINGS, identity))).toEqual(["fixed", "fixed", "fixed"]);
    expect([NQ, ES, { provider: "DXFEED", symbol: "/MNQZ26:XCME", assetClass: "FUTURE" } as Identity].map((identity) => thresholdRuleFor(DEFAULT_LIQUIDITY_VOIDS_SETTINGS, identity))).toEqual(["learned", "learned", "learned"]);
    expect(thresholdRuleFor(undefined, NQ)).toBe("learned");
    expect(thresholdRuleFor({ thresholdsOther: "learned" }, BTC)).toBe("learned");
    expect(thresholdRuleFor({ thresholdsIndex: "fixed" }, NQ)).toBe("fixed");
    expect(thresholdRuleFor({ thresholdsIndex: "fixed" }, BTC)).toBe("fixed");
    expect(thresholdRuleFor({ thresholdsOther: "learned" }, NQ)).toBe("learned");
    expect(thresholdRuleFor({ thresholdsOther: "anything" as never }, BTC)).toBe("fixed");
    expect(learnedMaxTradedOf({ maxTradedByInstrument: {} }, NQ, 60_000)).toBe(100);
    expect(learnedMaxTradedOf({}, ES, 60_000)).toBe(300);
    expect(learnedMaxTradedOf({ maxTradedByInstrument: { [instrumentKey(NQ)]: 250 } }, NQ, 5 * 60_000)).toBe(425);
    expect(learnedMaxTradedOf({ maxTradedByInstrument: { [instrumentKey(NQ)]: 250 } }, ES, 60_000)).toBe(300);
    expect([isMaxTradedByInstrument({ a: 5 }), isMaxTradedByInstrument({ a: 0 }), isMaxTradedByInstrument([5]), isMaxTradedByInstrument(null)]).toEqual([true, false, false, false]);
    expect([maxTradedSliderRange(30), maxTradedSliderRange(300), maxTradedSliderRange(0)]).toEqual([{ min: 0.5, max: 300, step: 0.5 }, { min: 1, max: 3_000, step: 1 }, { min: 0.5, max: 100, step: 0.5 }]);
    expect((["high", "normal", "low"] as const).map((sensitivity) => learnedKOf({ sensitivity }))).toEqual([1, 1.25, 1.5]);
    expect(learnedKOf({ sensitivity: "odd" as never })).toBe(1.25);
    expect(warmupMsFor(BTC, 30_000)).toBe(120 * 30_000);
    expect(warmupMsFor(NQ, 480_000)).toBe(120 * 480_000);
    expect(warmupMsFor(AAPL, 30_000)).toBe(4 * 120 * 30_000);
  });

  it("turns the settings into model rules in rows and milliseconds, never under two rows", () => {
    const rules = sweepRulesFor(DEFAULT_LIQUIDITY_VOIDS_SETTINGS, 9, 0.25);
    expect(bubbleSizeFor(BTC)).toBe(10);
    expect(bubbleSizeFor({ provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT" })).toBe(2);
    expect(bubbleSizeFor(ES)).toBe(20);
    expect(rules).toMatchObject({ windowMs: 30_000, minMoveRows: 36 });
    expect(sweepRulesFor(DEFAULT_LIQUIDITY_VOIDS_SETTINGS, 1, 4).minMoveRows).toBe(2);
  });
});
