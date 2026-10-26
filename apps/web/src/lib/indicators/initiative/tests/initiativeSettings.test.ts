import { describe, expect, it } from "vitest";
import type { InitiativeBand } from "../../../../types/frames";
import { DEFAULT_BUYER_COLOR, DEFAULT_INITIATIVE_SETTINGS, DEFAULT_MIN_LEG_ATR, DEFAULT_SELLER_COLOR, DEFAULT_MIN_SCORE, INITIATIVE_CANDLE_LENGTHS, INITIATIVE_HISTORY_OPTIONS, INITIATIVE_SETTINGS_SCHEMA, MAX_SCORE, MIN_LEG_ATR_RANGE, SCORE_RANGE, initiativeCandleMsOf, initiativeColorOf, initiativeSideColorOf, initiativeHistoryDaysOf, initiativeMinLegAtrOf, initiativeMinScoreOf, initiativeOpacityOf, legReachAtr, shownBands, type InitiativeSettings } from "../initiativeSettings";

const T = 1_790_000_000_000;
const DAY = 86_400_000;

export function band(over: Partial<InitiativeBand> = {}): InitiativeBand {
  return {
    id: "b", candleMs: 60000, side: "up", dominant: "buyers", dominantShare: 0.9, score: 4,
    facts: { efficiency: { yes: true, value: 1 }, closes: { yes: true, value: 1 }, burst: { yes: false, value: 1.667 }, delta: { yes: true, rank: 0.85, share: 0.9 }, prints: { yes: true, rank: 1, perCandle: 1 } },
    pivotTs: T - 180_000, pivotPrice: 198, frozenTs: T, frozenPrice: 210, windowCandles: 3, atr: 1.5,
    legExtremePrice: 214, legExtremeTs: T + 120_000, legEndTs: null, updatedAt: T + 180_000, origin: "runtime", ...over,
  };
}

describe("initiative settings", () => {
  it("defaults: a day of history, buyers green and sellers red, opacity 0.6, score at least 4 of 5, a leg of at least 7.5 ATR, the shade and the chip shown", () => {
    expect(DEFAULT_INITIATIVE_SETTINGS).toEqual({ opacity: 0.6, buyerColor: "#22c55e", sellerColor: "#ef4444", historyDays: 1, minScore: 4, minLegAtr: 7.5, showShade: true, showLabels: true });
    expect([DEFAULT_BUYER_COLOR, DEFAULT_SELLER_COLOR]).toEqual(["#22c55e", "#ef4444"]);
    expect([SCORE_RANGE, DEFAULT_MIN_SCORE, MAX_SCORE]).toEqual([[0, 5], 4, 5]);
    expect([MIN_LEG_ATR_RANGE, DEFAULT_MIN_LEG_ATR]).toEqual([[3, 10], 7.5]);
    expect([undefined, 1, 4.2, 4.26, 12, Number.NaN].map((minLegAtr) => initiativeMinLegAtrOf({ minLegAtr }))).toEqual([7.5, 3, 4, 4.5, 10, 7.5]);
    expect(legReachAtr(band({ pivotPrice: 100, legExtremePrice: 94, atr: 1.5 }))).toBe(4);
    expect(legReachAtr(band({ pivotPrice: 100, legExtremePrice: 106, atr: 1.5 }))).toBe(4);
    expect(INITIATIVE_HISTORY_OPTIONS.map(([days]) => days)).toEqual([0, 1, 3, 5, 7]);
    expect(initiativeHistoryDaysOf(undefined)).toBe(1);
    expect(initiativeHistoryDaysOf({ historyDays: 0 })).toBe(0);
    expect(initiativeHistoryDaysOf({ historyDays: 5 })).toBe(5);
    expect(initiativeHistoryDaysOf({ historyDays: 4 })).toBe(1);
    expect([undefined, -1, 2.6, 4.4, 9].map((minScore) => initiativeMinScoreOf({ minScore }))).toEqual([4, 0, 3, 4, 5]);
    expect(initiativeMinScoreOf({ minScore: Number.NaN })).toBe(4);
  });

  it("the schema is the score floor, the leg floor, the history, the shade and chip switches, the two colours and the opacity, in that order, every slider clamped on restore", () => {
    expect(INITIATIVE_SETTINGS_SCHEMA.map((field) => (field.kind === "staticHint" ? null : [field.key, field.kind, field.affects]))).toEqual([
      ["minScore", "slider", "recompute"],
      ["minLegAtr", "slider", "recompute"],
      ["historyDays", "select", "recompute"],
      ["showShade", "boolean", "cosmetic"],
      ["showLabels", "boolean", "cosmetic"],
      ["buyerColor", "color", "cosmetic"],
      ["sellerColor", "color", "cosmetic"],
      ["opacity", "slider", "cosmetic"],
    ]);
    const sliders = INITIATIVE_SETTINGS_SCHEMA.filter((field) => field.kind === "slider");
    expect(sliders.map((field) => (field.kind === "slider" ? [field.min, field.max, field.step, field.clampOnRestore] : null))).toEqual([[0, 5, 1, true], [3, 10, 0.5, true], [0.15, 1, 0.05, true]]);
    const history = INITIATIVE_SETTINGS_SCHEMA.find((field) => field.kind !== "staticHint" && field.key === "historyDays");
    expect(history?.kind === "select" ? history.options.map((option) => option.value) : null).toEqual([0, 1, 3, 5, 7]);
  });

  it("colours follow the dominant side and fall back to green for buyers and red for sellers; opacity is clamped", () => {
    expect(initiativeColorOf(undefined, "buyers")).toBe(DEFAULT_BUYER_COLOR);
    expect(initiativeColorOf(undefined, "sellers")).toBe(DEFAULT_SELLER_COLOR);
    expect(initiativeColorOf({ buyerColor: "", sellerColor: "#123456" }, "sellers")).toBe("#123456");
    expect(initiativeColorOf({ buyerColor: "", sellerColor: "#123456" }, "buyers")).toBe(DEFAULT_BUYER_COLOR);
    expect(initiativeColorOf({ buyerColor: "#abcdef" }, "buyers")).toBe("#abcdef");
    expect([initiativeSideColorOf(undefined, "up"), initiativeSideColorOf(undefined, "down"), initiativeSideColorOf({ sellerColor: "#123456" }, "down")]).toEqual([DEFAULT_BUYER_COLOR, DEFAULT_SELLER_COLOR, "#123456"]);
    expect(initiativeOpacityOf({ opacity: 2 })).toBe(1);
    expect(initiativeOpacityOf({ opacity: -1 })).toBe(0);
    expect(initiativeOpacityOf({ opacity: Number.NaN })).toBe(0.6);
    expect(initiativeOpacityOf(undefined)).toBe(0.6);
  });

  it("the engine runs on every chart timeframe from 1m to 1D, an equity up to 30m; a custom interval has no engine", () => {
    expect([...INITIATIVE_CANDLE_LENGTHS]).toEqual([60_000, 120_000, 180_000, 300_000, 900_000, 1_800_000, 3_600_000, 14_400_000, 21_600_000, 43_200_000, 86_400_000]);
    expect(initiativeCandleMsOf(60_000)).toBe(60_000);
    expect(initiativeCandleMsOf(86_400_000)).toBe(86_400_000);
    expect(initiativeCandleMsOf(240_000)).toBeNull();
    expect(initiativeCandleMsOf(1_800_000, "EQUITY")).toBe(1_800_000);
    expect(initiativeCandleMsOf(3_600_000, "EQUITY")).toBeNull();
    expect(initiativeCandleMsOf(3_600_000, "FUTURE")).toBe(3_600_000);
  });

  it("shown bands are the chart candle's, at or above the score floor, their leg at or above the leg floor so far; History Off keeps the runtime's own, a span adds the stored and host ones frozen inside it", () => {
    const live = band();
    const small = band({ id: "small", legExtremePrice: 204 });
    const smallDown = band({ id: "smallDown", side: "down", pivotPrice: 214, frozenPrice: 209, legExtremePrice: 207.5 });
    const stored = band({ id: "old", origin: "stored", pivotTs: T - 2 * DAY - 180_000, frozenTs: T - 2 * DAY, legExtremeTs: T - 2 * DAY, updatedAt: T - 2 * DAY });
    const other = band({ id: "5m", candleMs: 300000 });
    const weak = band({ id: "weak", score: 2 });
    const edge = band({ id: "edge", score: 3 });
    const host = band({ id: "h", origin: "host" });
    const all = [live, small, smallDown, stored, other, weak, edge, host];
    const ids = (settings: InitiativeSettings, candleMs: number | null = 60_000) => shownBands(all, settings, candleMs, T).map((b) => b.id);
    expect(ids({ ...DEFAULT_INITIATIVE_SETTINGS, historyDays: 0 })).toEqual(["b"]);
    expect(ids({ ...DEFAULT_INITIATIVE_SETTINGS, historyDays: 1 })).toEqual(["b", "h"]);
    expect(ids({ ...DEFAULT_INITIATIVE_SETTINGS, historyDays: 3 })).toEqual(["b", "old", "h"]);
    expect(ids({ ...DEFAULT_INITIATIVE_SETTINGS, minScore: 3 })).toEqual(["b", "edge", "h"]);
    expect(ids({ ...DEFAULT_INITIATIVE_SETTINGS, historyDays: 3, minScore: 0 })).toEqual(["b", "old", "weak", "edge", "h"]);
    expect(ids({ ...DEFAULT_INITIATIVE_SETTINGS, minScore: 4 })).toEqual(["b", "h"]);
    expect(ids({ ...DEFAULT_INITIATIVE_SETTINGS, minScore: 5 })).toEqual([]);
    expect(ids({ ...DEFAULT_INITIATIVE_SETTINGS, minLegAtr: 4 })).toEqual(["b", "small", "smallDown", "h"]);
    expect(ids({ ...DEFAULT_INITIATIVE_SETTINGS, minLegAtr: 4.5 })).toEqual(["b", "h"]);
    expect(ids({ ...DEFAULT_INITIATIVE_SETTINGS, minLegAtr: 10 })).toEqual(["b", "h"]);
    expect(ids({ ...DEFAULT_INITIATIVE_SETTINGS, minLegAtr: 11 })).toEqual(["b", "h"]);
    expect(ids({ ...DEFAULT_INITIATIVE_SETTINGS, minLegAtr: 3 }).includes("small")).toBe(true);
    expect(ids(DEFAULT_INITIATIVE_SETTINGS, 300_000)).toEqual(["5m"]);
    expect(ids(DEFAULT_INITIATIVE_SETTINGS, null)).toEqual([]);
    expect(shownBands([band({ frozenTs: T - DAY, pivotTs: T - DAY - 180_000, origin: "host" })], { ...DEFAULT_INITIATIVE_SETTINGS, historyDays: 1 }, 60_000, T)).toHaveLength(1);
    expect(shownBands([band({ frozenTs: T - DAY - 1, pivotTs: T - DAY - 180_000, origin: "host" })], { ...DEFAULT_INITIATIVE_SETTINGS, historyDays: 1 }, 60_000, T)).toHaveLength(0);
  });
});
