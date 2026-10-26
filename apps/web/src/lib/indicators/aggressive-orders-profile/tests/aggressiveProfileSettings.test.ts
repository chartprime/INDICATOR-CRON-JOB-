import { describe, expect, it } from "vitest";
import { DEFAULT_LIQUIDITY_SETTINGS } from "../../passive-liquidity/liquiditySettings";
import { AGGRESSIVE_PROFILE_SETTINGS_SCHEMA, DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, FALLBACK_FLOOR_MAX, FALLBACK_FLOOR_SPAN, FLOOR_DECADES, FLOOR_MANTISSAS, FLOOR_TOP_REACH, MAX_OUTLIER_FROM, OUTLIER_STEP, PROFILE_VIEWS, floorAt, floorNumberText, floorPosition, floorScaleFor, floorStops, outlierText, readerSettingsOf, sizeText } from "../aggressiveProfileSettings";

describe("aggressive orders profile settings", () => {
  it("starts on the heatmap's side colours and print floor, as a net delta with bars over twice the average highlighted", () => {
    expect(DEFAULT_AGGRESSIVE_PROFILE_SETTINGS).toEqual({
      floor: 0,
      profileView: "delta",
      outlierFrom: 2,
      buyColor: DEFAULT_LIQUIDITY_SETTINGS.bidColor,
      sellColor: DEFAULT_LIQUIDITY_SETTINGS.askColor,
    });
  });

  it("declares one field per setting for the presets, each with the kind the dialog draws", () => {
    expect(AGGRESSIVE_PROFILE_SETTINGS_SCHEMA.map((field) => [field.kind === "staticHint" ? null : field.key, field.kind])).toEqual([
      ["floor", "numeric"],
      ["profileView", "select"],
      ["outlierFrom", "slider"],
      ["buyColor", "color"],
      ["sellColor", "color"],
    ]);
    const floor = AGGRESSIVE_PROFILE_SETTINGS_SCHEMA.find((field) => field.kind !== "staticHint" && field.key === "floor");
    expect(floor).toMatchObject({ min: 0, affects: "recompute" });
    const view = AGGRESSIVE_PROFILE_SETTINGS_SCHEMA.find((field) => field.kind !== "staticHint" && field.key === "profileView");
    expect(view).toMatchObject({ options: PROFILE_VIEWS, affects: "cosmetic" });
    expect(PROFILE_VIEWS).toEqual([{ value: "delta", label: "Net delta" }, { value: "sides", label: "Buys and sells" }]);
    const outlier = AGGRESSIVE_PROFILE_SETTINGS_SCHEMA.find((field) => field.kind !== "staticHint" && field.key === "outlierFrom");
    expect(outlier).toMatchObject({ min: 0, max: MAX_OUTLIER_FROM, step: OUTLIER_STEP, clampOnRestore: true, affects: "cosmetic" });
    expect([MAX_OUTLIER_FROM, OUTLIER_STEP]).toEqual([5, 0.5]);
  });

  it("tops the floor slider per instrument, 50 BTC, 1,000 ETH, 100 NQ, 300 ES and 2,000 shares, ten times the auto floor once the auto floor reaches the top, whole units on futures and equities, and a hundred times the auto floor elsewhere", () => {
    expect([FALLBACK_FLOOR_SPAN, FALLBACK_FLOOR_MAX, FLOOR_TOP_REACH]).toEqual([100, 100, 10]);
    const btc = { symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL" } as const;
    expect(floorScaleFor(btc, 0.2)).toEqual({ max: 50, whole: false });
    expect(floorScaleFor({ ...btc, marketKind: "SPOT" }, 0)).toEqual({ max: 50, whole: false });
    expect(floorScaleFor({ symbol: "ETH-USDT", provider: "BINANCE", marketKind: "PERPETUAL" }, 3)).toEqual({ max: 1_000, whole: false });
    expect(floorScaleFor({ symbol: "/NQZ26:XCME", provider: "DXFEED", assetClass: "FUTURE" }, 2)).toEqual({ max: 100, whole: true });
    expect(floorScaleFor({ symbol: "/ESZ26:XCME", provider: "DXFEED", assetClass: "FUTURE" }, 2)).toEqual({ max: 300, whole: true });
    expect(floorScaleFor({ symbol: "AAPL", provider: "DXFEED", assetClass: "EQUITY" }, 500)).toEqual({ max: 2_000, whole: true });
    expect(floorScaleFor({ symbol: "AAPL", provider: "DXFEED", assetClass: "EQUITY" }, 1_999)).toEqual({ max: 2_000, whole: true });
    expect(floorScaleFor({ symbol: "TSLA", provider: "DXFEED", assetClass: "EQUITY" }, 2_000)).toEqual({ max: 20_000, whole: true });
    expect(floorScaleFor({ symbol: "/NQZ26:XCME", provider: "DXFEED", assetClass: "FUTURE" }, 100)).toEqual({ max: 1_000, whole: true });
    expect(floorScaleFor({ symbol: "/ESZ26:XCME", provider: "DXFEED", assetClass: "FUTURE" }, 300)).toEqual({ max: 5_000, whole: true });
    expect(floorScaleFor(btc, 60)).toEqual({ max: 1_000, whole: false });
    expect(floorScaleFor(btc, Number.NaN)).toEqual({ max: 50, whole: false });
    expect(floorScaleFor({ symbol: "ETH-USDT", provider: "BINANCE", marketKind: "SPOT" }, 1_000)).toEqual({ max: 10_000, whole: false });
    expect(floorScaleFor({ symbol: "/CLZ26:XNYM", provider: "DXFEED", assetClass: "FUTURE" }, 3)).toEqual({ max: 500, whole: true });
    expect(floorScaleFor({ symbol: "SOL-USDT", provider: "BINANCE", marketKind: "SPOT" }, 8.2)).toEqual({ max: 1_000, whole: false });
    expect(floorScaleFor(null, 0.2)).toEqual({ max: 20, whole: false });
    expect(floorScaleFor(null, 2)).toEqual({ max: 200, whole: false });
    expect(floorScaleFor(null, 0)).toEqual({ max: 100, whole: false });
    expect(floorScaleFor(null, Number.NaN)).toEqual({ max: 100, whole: false });
    expect(floorScaleFor(null, Infinity)).toEqual({ max: 100, whole: false });
  });

  it("spaces the floor slider's stops by ratio, from three decades under the top or one whole unit, the top included, above the floor it starts from, and finds the nearest stop for a floor", () => {
    expect(FLOOR_MANTISSAS).toEqual([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8]);
    expect(FLOOR_DECADES).toBe(3);
    const btc = floorStops({ max: 50, whole: false });
    expect(btc).toEqual([0.05, 0.06, 0.08, 0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50]);
    expect(floorStops({ max: 100, whole: true })).toEqual([1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100]);
    expect(floorStops({ max: 300, whole: true }).slice(-6)).toEqual([100, 120, 150, 200, 250, 300]);
    expect(floorStops({ max: 2_000, whole: true }).slice(0, 3)).toEqual([1, 2, 3]);
    expect(floorStops({ max: 2_000, whole: true }).slice(-4)).toEqual([1_000, 1_200, 1_500, 2_000]);
    expect(floorStops({ max: 1_000, whole: false }).slice(0, 3)).toEqual([1, 1.2, 1.5]);
    expect(floorStops({ max: 0.5, whole: true })).toEqual([0.5]);
    expect(floorStops({ max: 50, whole: false }, 10)).toEqual([12, 15, 20, 25, 30, 40, 50]);
    expect(floorStops({ max: 50, whole: false }, 0.22).slice(0, 2)).toEqual([0.25, 0.3]);
    expect(floorStops({ max: 100, whole: true }, 2).slice(0, 3)).toEqual([3, 4, 5]);
    expect(floorStops({ max: 50, whole: false }, 49)).toEqual([50]);
    expect(floorStops({ max: 50, whole: false }, 50)).toEqual([]);
    expect([floorPosition(btc, 0), floorPosition(btc, 0.05), floorPosition(btc, 10), floorPosition(btc, 10.5), floorPosition(btc, 11.5), floorPosition(btc, 2.05), floorPosition(btc, 75), floorPosition(btc, 0.01), floorPosition(btc, -1), floorPosition([], 3)]).toEqual([0, 1, 24, 24, 25, 17, 31, 1, 0, 0]);
    expect([floorAt(btc, 0), floorAt(btc, 1), floorAt(btc, 24), floorAt(btc, 31), floorAt(btc, 40), floorAt(btc, 23.6), floorAt(btc, -1), floorAt(btc, 0.6), floorAt([], 3)]).toEqual([0, 0.05, 10, 50, 50, 10, 0, 0, 0]);
  });

  it("hands the reader only the floor, so a colour, the view or the highlight never re-reads the range", () => {
    expect(readerSettingsOf({ ...DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, buyColor: "#123456", sellColor: "#654321", profileView: "sides", outlierFrom: 4, floor: 7 })).toEqual({ floor: 7 });
  });

  it("writes a floor whole from 10 and in k and M past a thousand, with two decimals under 10", () => {
    expect([floorNumberText(14), floorNumberText(8.25), floorNumberText(0.5), floorNumberText(0.125), floorNumberText(1_500), floorNumberText(12_400), floorNumberText(2_345_000)]).toEqual(["14", "8.25", "0.5", "0.13", "1.5k", "12k", "2.3M"]);
    expect([sizeText(0), sizeText(0.3), sizeText(999.4), sizeText(999.6), sizeText(1505.4), sizeText(9_960), sizeText(999_600)]).toEqual(["0", "<1", "999", "1k", "1.5k", "10k", "1M"]);
  });

  it("names the highlight by its multiple of the average, or off at zero", () => {
    expect([outlierText(0), outlierText(2), outlierText(2.5), outlierText(1.333), outlierText(-1)]).toEqual(["Highlight bars off", "Highlight bars over 2× the average", "Highlight bars over 2.5× the average", "Highlight bars over 1.3× the average", "Highlight bars off"]);
  });
});
