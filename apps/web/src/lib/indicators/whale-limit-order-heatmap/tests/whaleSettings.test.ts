import { describe, expect, it } from "vitest";
import { DEFAULT_WHALE_SETTINGS, WHALE_ALL_OUTCOMES_MASK, WHALE_FALLBACK_BANDS, bandsFor, cutUsdOf, normalizeWhaleSettings, outcomesOf, sideOf, whaleLegendDetail } from "../whaleSettings";

describe("whale heatmap settings", () => {
  it("gives the defaults for anything that is not an object, and keeps a whole valid object as it is", () => {
    for (const bad of [undefined, null, 5, "x", []]) expect(normalizeWhaleSettings(bad)).toEqual(DEFAULT_WHALE_SETTINGS);
    const custom = { cutPreset: 3, cutBasis: "ratio", ratioMin: 7, fills: false, outcomeMask: 31, sideFilter: "ask", liveView: "both", labels: false, hours: 168, thickness: 6 };
    expect(normalizeWhaleSettings(custom)).toEqual(custom);
    expect(DEFAULT_WHALE_SETTINGS).toMatchObject({ cutPreset: 2, cutBasis: "usd", fills: true, sideFilter: "both", liveView: "ladder", labels: true, hours: 48, thickness: 3 });
    expect(outcomesOf(DEFAULT_WHALE_SETTINGS.outcomeMask)).toEqual([true, true, true, true, false]);
  });

  it("clamps numbers into their range, rounds integers, and falls back for a value of the wrong kind or an unknown choice", () => {
    expect(normalizeWhaleSettings({ cutPreset: 9 }).cutPreset).toBe(4);
    expect(normalizeWhaleSettings({ cutPreset: -3 }).cutPreset).toBe(0);
    expect(normalizeWhaleSettings({ cutPreset: 1.6 }).cutPreset).toBe(2);
    expect(normalizeWhaleSettings({ cutPreset: "2" }).cutPreset).toBe(DEFAULT_WHALE_SETTINGS.cutPreset);
    expect(normalizeWhaleSettings({ cutPreset: Number.NaN }).cutPreset).toBe(DEFAULT_WHALE_SETTINGS.cutPreset);
    expect(normalizeWhaleSettings({ thickness: 99 }).thickness).toBe(8);
    expect(normalizeWhaleSettings({ thickness: 0 }).thickness).toBe(2);
    expect(normalizeWhaleSettings({ ratioMin: 0 }).ratioMin).toBe(1);
    expect(normalizeWhaleSettings({ ratioMin: 1e9 }).ratioMin).toBe(1_000);
    expect(normalizeWhaleSettings({ ratioMin: 2.5 }).ratioMin).toBe(2.5);
    expect(normalizeWhaleSettings({ outcomeMask: 99 }).outcomeMask).toBe(WHALE_ALL_OUTCOMES_MASK);
    expect(normalizeWhaleSettings({ outcomeMask: 0 }).outcomeMask).toBe(0);
    expect(normalizeWhaleSettings({ hours: 24 }).hours).toBe(24);
    expect(normalizeWhaleSettings({ hours: 30 }).hours).toBe(48);
    expect(normalizeWhaleSettings({ cutBasis: "pct" }).cutBasis).toBe("usd");
    expect(normalizeWhaleSettings({ sideFilter: "up" }).sideFilter).toBe("both");
    expect(normalizeWhaleSettings({ liveView: "dom" }).liveView).toBe("ladder");
    expect(normalizeWhaleSettings({ fills: "yes", labels: 1 })).toMatchObject({ fills: true, labels: true });
  });

  it("words the legend detail from the cut, the dollar size it comes to on this market, the fills switch and the hours", () => {
    const base = DEFAULT_WHALE_SETTINGS;
    expect(whaleLegendDetail(base, "PERPETUAL", "BTC-USDT")).toBe("top 10% · ≥ $18.8M + fills · 48 h");
    expect(whaleLegendDetail({ ...base, cutPreset: 4, fills: false, hours: 168 }, "SPOT", "ETH-USDT")).toBe("top 1% · ≥ $3.5M · 168 h");
    expect(whaleLegendDetail({ ...base, cutBasis: "ratio", ratioMin: 9 }, "SPOT", "BTC-USDT")).toBe("importance ≥ 9x + fills · 48 h");
    expect(whaleLegendDetail(base, "FUTURE", "/NQZ26:XCME")).toBe("top 10% + fills · 48 h");
  });

  it("turns the outcome mask into five switches in the order filled, partial, touched, pulled, moved", () => {
    expect(outcomesOf(0)).toEqual([false, false, false, false, false]);
    expect(outcomesOf(0b10101)).toEqual([true, false, true, false, true]);
    expect(outcomesOf(0b00011)).toEqual([true, true, false, false, false]);
    expect(outcomesOf(WHALE_ALL_OUTCOMES_MASK)).toEqual([true, true, true, true, true]);
  });

  it("maps the side setting to the store's filter, and resolves a cut preset to the market's dollar size", () => {
    expect([sideOf("both"), sideOf("bid"), sideOf("ask")]).toEqual(["both", 0, 1]);
    const bands = { p50: 1, p75: 2, p90: 3, p95: 4, p99: 5 };
    expect([0, 1, 2, 3, 4].map((cutPreset) => cutUsdOf({ ...DEFAULT_WHALE_SETTINGS, cutPreset }, bands))).toEqual([1, 2, 3, 4, 5]);
  });

  it("knows the four Binance markets by kind and symbol with or without the dash, rising from median to the 99th percentile, and nothing else", () => {
    expect(bandsFor("PERPETUAL", "BTC-USDT")).toBe(WHALE_FALLBACK_BANDS["PERPETUAL:BTCUSDT"]);
    expect(bandsFor("SPOT", "ETHUSDT")).toBe(WHALE_FALLBACK_BANDS["SPOT:ETHUSDT"]);
    expect(bandsFor("FUTURE", "/NQZ26:XCME")).toBeNull();
    expect(bandsFor("PERPETUAL", "SOLUSDT")).toBeNull();
    expect(Object.keys(WHALE_FALLBACK_BANDS).sort()).toEqual(["PERPETUAL:BTCUSDT", "PERPETUAL:ETHUSDT", "SPOT:BTCUSDT", "SPOT:ETHUSDT"]);
    for (const bands of Object.values(WHALE_FALLBACK_BANDS)) expect([bands.p50, bands.p75, bands.p90, bands.p95, bands.p99].every((step, index, all) => step > 0 && (index === 0 || step >= all[index - 1]))).toBe(true);
  });
});
