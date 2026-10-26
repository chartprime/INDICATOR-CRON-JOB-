import { describe, expect, it } from "vitest";
import type { ExhaustionShade } from "../../../../types/frames";
import { DEFAULT_LIQUIDITY_SETTINGS } from "../../passive-liquidity/liquiditySettings";
import { DEFAULT_EXHAUSTION_SETTINGS, EXHAUSTION_CANDLE_LENGTHS, EXHAUSTION_HISTORY_OPTIONS, exhaustionCandleMsOf, exhaustionColorOf, exhaustionHistoryDaysOf, exhaustionLiveSinceText, exhaustionCalibrated, exhaustionMinScoreOf, exhaustionOpacityOf, exhaustionZoneScaleOf, legSettingsOf, shownShades, zoneHeightOf, DEFAULT_MIN_SCORE, DEFAULT_ZONE_SCALE, SCORE_RANGE, ZONE_SCALE_RANGE, ZONE_SHARE, type ExhaustionSettings } from "../exhaustionSettings";

const T = 1_790_000_000_000;
const DAY = 86_400_000;

function shade(over: Partial<ExhaustionShade> = {}): ExhaustionShade {
  return {
    id: "s", candleMs: 60000, side: "buyers", status: "held", intensity: 2, score: 5, readings: { rate: true, progress: true, delta: true, divergence: false, prints: true, book: true }, values: { rate: 0.211, progress: 0, delta: -0.4, divergence: -1.4, prints: null, book: 0.5 },
    raw: { own: 3, other: 7, legOwn: 14.222, moved: 0, legMoved: 1.778, big: 0, legBig: 0, extremeOwn: 20, extremeOther: 0, bookNow: 1, bookAt: 2, bookBand: 0 },
    startTs: T - 120_000, endTs: T - 60_000, extremeTs: T - 180_000, extremePrice: 104, legStartTs: T - 600_000, legStartPrice: 101,
    legSize: 3, efficiency: 1, atr: 0.25, judgedAt: T, updatedAt: T, origin: "runtime", ...over,
  };
}

describe("exhaustion settings", () => {
  it("defaults: a day of history, the heatmap's colours, broken shown, opacity 0.6, the chart's legs off, nested legs shown, the exhaustion area at x2 with its legs", () => {
    expect(DEFAULT_EXHAUSTION_SETTINGS).toEqual({ opacity: 0.6, buyerColor: DEFAULT_LIQUIDITY_SETTINGS.askColor, sellerColor: DEFAULT_LIQUIDITY_SETTINGS.bidColor, showBroken: true, historyDays: 1, showLegs: false, hideNestedLegs: false, showMonitor: true, legAtr: 8, legReverseAtr: 3, legEfficiency: 0.5, minScore: 5, zoneScale: 2, zonesOnly: false });
    expect(legSettingsOf(undefined)).toEqual({ atrPeriod: 14, atrMultiple: 8, reverseAtr: 3, minEfficiency: 0.5 });
    expect(legSettingsOf({ legAtr: 100, legReverseAtr: 0, legEfficiency: Number.NaN })).toEqual({ atrPeriod: 14, atrMultiple: 40, reverseAtr: 1, minEfficiency: 0.5 });
    expect(legSettingsOf({ legAtr: 12, legReverseAtr: 2.5, legEfficiency: 0.7 })).toEqual({ atrPeriod: 14, atrMultiple: 12, reverseAtr: 2.5, minEfficiency: 0.7 });
    expect(EXHAUSTION_HISTORY_OPTIONS.map(([days]) => days)).toEqual([0, 1, 3, 5, 7]);
    expect(exhaustionHistoryDaysOf(undefined)).toBe(1);
    expect(exhaustionHistoryDaysOf({ historyDays: 0 })).toBe(0);
    expect(exhaustionHistoryDaysOf({ historyDays: 5 })).toBe(5);
    expect(exhaustionHistoryDaysOf({ historyDays: 4 })).toBe(1);
  });

  it("the exhaustion area is the engine's zone, a fifth of the leg, times the slider: x2 by default, clamped to x1..x5, never more than the leg", () => {
    expect([DEFAULT_ZONE_SCALE, ZONE_SCALE_RANGE, ZONE_SHARE]).toEqual([2, [1, 5], 0.2]);
    expect(exhaustionZoneScaleOf(undefined)).toBe(2);
    expect(exhaustionZoneScaleOf({ zoneScale: 3.5 })).toBe(3.5);
    expect(exhaustionZoneScaleOf({ zoneScale: 0 })).toBe(1);
    expect(exhaustionZoneScaleOf({ zoneScale: 9 })).toBe(5);
    expect(exhaustionZoneScaleOf({ zoneScale: Number.NaN })).toBe(2);
    expect(zoneHeightOf({ legSize: 12 }, 1)).toBeCloseTo(2.4);
    expect(zoneHeightOf({ legSize: 12 }, 2)).toBeCloseTo(4.8);
    expect(zoneHeightOf({ legSize: 12 }, 5)).toBe(12);
    expect(zoneHeightOf({ legSize: 12 }, 6)).toBe(12);
  });

  it("colours fall back to the heatmap's per side, opacity is clamped", () => {
    expect(exhaustionColorOf(undefined, "buyers")).toBe(DEFAULT_LIQUIDITY_SETTINGS.askColor);
    expect(exhaustionColorOf({ buyerColor: "", sellerColor: "#123456" }, "sellers")).toBe("#123456");
    expect(exhaustionColorOf({ buyerColor: "", sellerColor: "#123456" }, "buyers")).toBe(DEFAULT_LIQUIDITY_SETTINGS.askColor);
    expect(exhaustionOpacityOf({ opacity: 2 })).toBe(1);
    expect(exhaustionOpacityOf({ opacity: -1 })).toBe(0);
    expect(exhaustionOpacityOf({ opacity: Number.NaN })).toBe(0.6);
  });

  it("the engine runs on every chart timeframe from 1m to 1D; a custom interval off that list has no engine", () => {
    expect([...EXHAUSTION_CANDLE_LENGTHS]).toEqual([60_000, 120_000, 180_000, 300_000, 900_000, 1_800_000, 3_600_000, 14_400_000, 21_600_000, 43_200_000, 86_400_000]);
    expect(exhaustionCandleMsOf(60_000)).toBe(60_000);
    expect(exhaustionCandleMsOf(3_600_000)).toBe(3_600_000);
    expect(exhaustionCandleMsOf(120_000)).toBe(120_000);
    expect(exhaustionCandleMsOf(86_400_000)).toBe(86_400_000);
    expect(exhaustionCandleMsOf(240_000)).toBeNull();
    expect(exhaustionCandleMsOf(172_800_000)).toBeNull();
  });

  it("an equity has no engine above 30m, where the chart anchors its candles to the session open and the runtime buckets on UTC; futures and crypto keep every length", () => {
    expect(exhaustionCandleMsOf(1_800_000, "EQUITY")).toBe(1_800_000);
    expect(exhaustionCandleMsOf(60_000, "EQUITY")).toBe(60_000);
    expect(exhaustionCandleMsOf(3_600_000, "EQUITY")).toBeNull();
    expect(exhaustionCandleMsOf(14_400_000, "EQUITY")).toBeNull();
    expect(exhaustionCandleMsOf(86_400_000, "EQUITY")).toBeNull();
    expect(exhaustionCandleMsOf(3_600_000, "FUTURE")).toBe(3_600_000);
    expect(exhaustionCandleMsOf(86_400_000, undefined)).toBe(86_400_000);
  });

  it("shown shades are the chart candle's; History Off keeps the runtime's own, a span adds the stored ones that ended inside it; broken ones leave with the switch", () => {
    const live = shade();
    const stored = shade({ id: "old", origin: "stored", endTs: T - 2 * DAY, startTs: T - 2 * DAY - 60_000, extremeTs: T - 2 * DAY - 120_000, legStartTs: T - 2 * DAY - 600_000 });
    const other = shade({ id: "5m", candleMs: 300000 });
    const broke = shade({ id: "b", status: "broke" });
    const host = shade({ id: "h", origin: "host" });
    const all = [live, stored, other, broke, host];
    expect(shownShades(all, { ...DEFAULT_EXHAUSTION_SETTINGS, historyDays: 0 }, 60_000, T).map((s) => s.id)).toEqual(["s", "b"]);
    expect(shownShades(all, { ...DEFAULT_EXHAUSTION_SETTINGS, historyDays: 1 }, 60_000, T).map((s) => s.id)).toEqual(["s", "b", "h"]);
    expect(shownShades(all, { ...DEFAULT_EXHAUSTION_SETTINGS, historyDays: 3 }, 60_000, T).map((s) => s.id)).toEqual(["s", "old", "b", "h"]);
    expect(shownShades(all, { ...DEFAULT_EXHAUSTION_SETTINGS, historyDays: 3, showBroken: false }, 60_000, T).map((s) => s.id)).toEqual(["s", "old", "h"]);
    expect(shownShades(all, DEFAULT_EXHAUSTION_SETTINGS, 300_000, T).map((s) => s.id)).toEqual(["5m"]);
    expect(shownShades(all, DEFAULT_EXHAUSTION_SETTINGS, null, T)).toEqual([]);
  });

  it("Hide nested legs drops a shade whose leg sits inside another shown shade's leg of the same side, in time and price, keeping the bigger leg, the later shade of equal legs, the greater id of twins; different sides and a wider span stay", () => {
    const base = { candleMs: 60_000 as const, side: "buyers" as const, status: "held" as const, intensity: 2, score: 5, readings: { rate: true, progress: true, delta: true, divergence: false, prints: true, book: true }, values: { rate: 0.3, progress: 0.2, delta: -0.25, divergence: 0.1, prints: 0.2, book: 0.5 }, raw: { own: 3, other: 7, legOwn: 14.222, moved: 0, legMoved: 1.778, big: 0, legBig: 0, extremeOwn: 20, extremeOther: 0, bookNow: 1, bookAt: 2, bookBand: 0 as const }, efficiency: 0.8, atr: 1, judgedAt: T - 1000, updatedAt: T - 1000, origin: "runtime" as const };
    const big = { ...base, id: "big", startTs: T - 600_000, endTs: T - 300_000, extremeTs: T - 650_000, extremePrice: 120, legStartTs: T - 2_400_000, legStartPrice: 100, legSize: 20 };
    const inner = { ...base, id: "inner", startTs: T - 1_500_000, endTs: T - 1_200_000, extremeTs: T - 1_550_000, extremePrice: 110, legStartTs: T - 2_300_000, legStartPrice: 101, legSize: 9 };
    const wider = { ...base, id: "wider", startTs: T - 500_000, endTs: T - 200_000, extremeTs: T - 550_000, extremePrice: 115, legStartTs: T - 2_500_000, legStartPrice: 102, legSize: 13 };
    const other = { ...inner, id: "other", side: "sellers" as const, legStartPrice: 118, extremePrice: 105, legSize: 13 };
    const all = [big, inner, wider, other];
    const on = { ...DEFAULT_EXHAUSTION_SETTINGS, historyDays: 1, hideNestedLegs: true };
    expect(shownShades(all, { ...DEFAULT_EXHAUSTION_SETTINGS, historyDays: 1 }, 60_000, T).map((s) => s.id)).toEqual(["big", "inner", "wider", "other"]);
    expect(shownShades(all, on, 60_000, T).map((s) => s.id)).toEqual(["big", "wider", "other"]);
    expect(shownShades([inner, { ...big, legSize: 9 }], on, 60_000, T).map((s) => s.id)).toEqual(["big"]);
    expect(shownShades([big, { ...big, id: "same" }], on, 60_000, T).map((s) => s.id)).toEqual(["same"]);
    expect(shownShades([inner, { ...big, endTs: T - 1_300_000 }], on, 60_000, T).map((s) => s.id)).toEqual(["inner", "big"]);
    expect(shownShades([inner, { ...big, endTs: T - 1_300_000 }, wider], on, 60_000, T).map((s) => s.id)).toEqual(["inner", "big", "wider"]);
    expect(shownShades([{ ...inner, startTs: T - 400_000, endTs: T - 350_000 }, { ...big, legSize: 9 }], on, 60_000, T).map((s) => s.id)).toEqual(["inner", "big"]);
    expect(shownShades([inner, { ...big, legStartPrice: 102 }], on, 60_000, T).map((s) => s.id)).toEqual(["inner", "big"]);
    expect(shownShades([inner, { ...big, candleMs: 300_000 }], on, 60_000, T).map((s) => s.id)).toEqual(["inner"]);
  });

  it("the live-since text is the UTC day and minute", () => {
    expect(exhaustionLiveSinceText(null)).toBe("");
    expect(exhaustionLiveSinceText(Date.UTC(2026, 9, 10, 7, 5))).toBe("10-10 07:05 UTC");
  });

  it("the leg sliders and the confidence floor filter the runtime's shades too: size in ATR, straightness and score, at once; the floor starts at five", () => {
    const list = [shade({ id: "big" }), shade({ id: "small", atr: 0.5 }), shade({ id: "bent", efficiency: 0.4 }), shade({ id: "weak", score: 3 })];
    const ids = (settings: ExhaustionSettings) => shownShades(list, settings, 60000, T).map((s) => s.id);
    expect(ids(DEFAULT_EXHAUSTION_SETTINGS)).toEqual(["big"]);
    expect(ids({ ...DEFAULT_EXHAUSTION_SETTINGS, legAtr: 6 })).toEqual(["big", "small"]);
    expect(ids({ ...DEFAULT_EXHAUSTION_SETTINGS, legEfficiency: 0.3 })).toEqual(["big", "bent"]);
    expect(ids({ ...DEFAULT_EXHAUSTION_SETTINGS, legAtr: 12, legEfficiency: 0.95 })).toEqual(["big"]);
    expect(ids({ ...DEFAULT_EXHAUSTION_SETTINGS, minScore: 3 })).toEqual(["big", "weak"]);
    expect(ids({ ...DEFAULT_EXHAUSTION_SETTINGS, minScore: 4 })).toEqual(["big"]);
    expect(ids({ ...DEFAULT_EXHAUSTION_SETTINGS, minScore: 6 })).toEqual([]);
    expect([undefined, 0, 2.6, 4.4, 9].map((minScore) => exhaustionMinScoreOf({ minScore }))).toEqual([5, 3, 3, 4, 6]);
    expect([SCORE_RANGE, DEFAULT_MIN_SCORE]).toEqual([[3, 6], 5]);
  });

  it("the accuracy is calibrated only at the default leg size and straightness; the reversal and the confidence floor do not change it", () => {
    expect(exhaustionCalibrated(undefined)).toBe(true);
    expect(exhaustionCalibrated(DEFAULT_EXHAUSTION_SETTINGS)).toBe(true);
    expect(exhaustionCalibrated({ ...DEFAULT_EXHAUSTION_SETTINGS, legReverseAtr: 5, minScore: 6 })).toBe(true);
    expect(exhaustionCalibrated({ ...DEFAULT_EXHAUSTION_SETTINGS, legAtr: 6 })).toBe(false);
    expect(exhaustionCalibrated({ ...DEFAULT_EXHAUSTION_SETTINGS, legEfficiency: 0.45 })).toBe(false);
  });
});
