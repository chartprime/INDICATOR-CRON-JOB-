import { describe, expect, it } from "vitest";
import { DEFAULT_LIQUIDITY_SETTINGS } from "../../passive-liquidity/liquiditySettings";
import {
  CARD_SIZES,
  CRYPTO_PRINT_SCALE,
  DEFAULT_LIVE_RANGE_SETTINGS,
  DEFAULT_ZONE_COLOR,
  DEFAULT_ZONE_OPACITY,
  EQUITY_PRINT_SCALE,
  FUTURES_PRINT_SCALE,
  LIVE_RANGE_MODES,
  LIVE_RANGE_SETTINGS_SCHEMA,
  ROW_SETTINGS,
  VERDICT_SENSITIVITIES,
  VERDICT_Z_FROM,
  bigPrintOf,
  cardSizeOf,
  printScaleFor,
  rangeModeOf,
  rowShownOf,
  tipsShownOf,
  verdictSensitivityOf,
  zFromOf,
  zoneOpacityOf,
  zoneShownOf,
  type CardSize,
  type LiveRangeSettings,
  type VerdictSensitivity,
} from "../liveRangeSettings";

describe("Live Range Control settings", () => {
  it("defaults to the visible range, the instrument's own big print, the normal verdict, a blue zone at a tenth, the heatmap's bid and ask colours, a medium monitor, the zone, every row and the hover tips shown", () => {
    expect(DEFAULT_LIVE_RANGE_SETTINGS).toEqual({
      rangeMode: "visible",
      bigPrint: 0,
      verdictSensitivity: "normal",
      zoneColor: "#2962ff",
      zoneOpacity: 10,
      bidColor: DEFAULT_LIQUIDITY_SETTINGS.bidColor,
      askColor: DEFAULT_LIQUIDITY_SETTINGS.askColor,
      cardSize: "medium",
      showZone: true,
      showVolumeRow: true,
      showDeltaRow: true,
      showPrintsRow: true,
      showMinutesRow: true,
      showImpactRow: true,
      showTips: true,
    });
    expect(DEFAULT_ZONE_COLOR).toBe("#2962ff");
    expect(DEFAULT_ZONE_OPACITY).toBe(10);
  });

  it("offers three modes in this order: Visible range, Selected zone, Live", () => {
    expect(LIVE_RANGE_MODES).toEqual([["visible", "Visible range"], ["selected", "Selected zone"], ["live", "Live"]]);
    expect(Object.isFrozen(LIVE_RANGE_MODES)).toBe(true);
  });

  it("describes every setting once for the presets, the big print bounded and clamped on restore, and no zone width", () => {
    expect(LIVE_RANGE_SETTINGS_SCHEMA).toEqual([
      { kind: "radioGroup", key: "rangeMode", label: "Mode", options: [{ value: "visible", label: "Visible range" }, { value: "selected", label: "Selected zone" }, { value: "live", label: "Live" }], affects: "recompute" },
      { kind: "numeric", key: "bigPrint", label: "Big print from", min: 0, max: 50_000, step: 0.5, clampOnRestore: true, affects: "recompute" },
      { kind: "radioGroup", key: "verdictSensitivity", label: "Verdict sensitivity", options: [{ value: "high", label: "High" }, { value: "normal", label: "Normal" }, { value: "strict", label: "Strict" }], affects: "recompute" },
      { kind: "color", key: "zoneColor", label: "Zone colour", affects: "cosmetic" },
      { kind: "slider", key: "zoneOpacity", label: "Zone opacity", min: 1, max: 50, step: 1, affects: "cosmetic" },
      { kind: "color", key: "bidColor", label: "Bid colour", affects: "cosmetic" },
      { kind: "color", key: "askColor", label: "Ask colour", affects: "cosmetic" },
      { kind: "radioGroup", key: "cardSize", label: "Monitor size", options: [{ value: "small", label: "Small" }, { value: "medium", label: "Medium" }, { value: "large", label: "Large" }], affects: "cosmetic" },
      { kind: "boolean", key: "showZone", label: "Show zone", affects: "cosmetic" },
      { kind: "boolean", key: "showVolumeRow", label: "Show Traded volume", affects: "cosmetic" },
      { kind: "boolean", key: "showDeltaRow", label: "Show Delta", affects: "cosmetic" },
      { kind: "boolean", key: "showPrintsRow", label: "Show Big prints", affects: "cosmetic" },
      { kind: "boolean", key: "showMinutesRow", label: "Show Minutes won", affects: "cosmetic" },
      { kind: "boolean", key: "showImpactRow", label: "Show Price impact", affects: "cosmetic" },
      { kind: "boolean", key: "showTips", label: "Show hover tips", affects: "cosmetic" },
    ]);
    expect(Object.keys(DEFAULT_LIVE_RANGE_SETTINGS)).not.toContain("widthPct");
  });

  it("offers three verdict sensitivities in this order: High calls a side as soon as the z leaves 0, Normal from ±1, Strict from ±2; anything else reads as Normal", () => {
    expect(VERDICT_SENSITIVITIES).toEqual([["high", "High"], ["normal", "Normal"], ["strict", "Strict"]]);
    expect(Object.isFrozen(VERDICT_SENSITIVITIES)).toBe(true);
    expect(VERDICT_Z_FROM).toEqual({ high: 0, normal: 1, strict: 2 });
    expect(Object.isFrozen(VERDICT_Z_FROM)).toBe(true);
    expect(verdictSensitivityOf({ verdictSensitivity: "high" })).toBe("high");
    expect(verdictSensitivityOf({ verdictSensitivity: "strict" })).toBe("strict");
    expect(verdictSensitivityOf({ verdictSensitivity: "loose" as VerdictSensitivity })).toBe("normal");
    expect(verdictSensitivityOf({} as Pick<LiveRangeSettings, "verdictSensitivity">)).toBe("normal");
    expect(verdictSensitivityOf(undefined)).toBe("normal");
    expect([zFromOf({ verdictSensitivity: "high" }), zFromOf({ verdictSensitivity: "normal" }), zFromOf({ verdictSensitivity: "strict" }), zFromOf({ verdictSensitivity: "loose" as VerdictSensitivity }), zFromOf(undefined)]).toEqual([0, 1, 2, 1, 1]);
  });

  it("names the five rows in the card's order with the setting that shows each, and shows a row and the hover tips unless they were switched off", () => {
    expect(ROW_SETTINGS).toEqual([["volume", "showVolumeRow", "Traded volume"], ["delta", "showDeltaRow", "Delta"], ["prints", "showPrintsRow", "Big prints"], ["minutes", "showMinutesRow", "Minutes won"], ["impact", "showImpactRow", "Price impact"]]);
    expect(Object.isFrozen(ROW_SETTINGS)).toBe(true);
    expect(rowShownOf(DEFAULT_LIVE_RANGE_SETTINGS, "delta")).toBe(true);
    expect(rowShownOf({ ...DEFAULT_LIVE_RANGE_SETTINGS, showDeltaRow: false }, "delta")).toBe(false);
    expect(rowShownOf({ ...DEFAULT_LIVE_RANGE_SETTINGS, showDeltaRow: false }, "impact")).toBe(true);
    expect(ROW_SETTINGS.map(([row, key]) => rowShownOf({ ...DEFAULT_LIVE_RANGE_SETTINGS, [key]: false }, row))).toEqual([false, false, false, false, false]);
    expect(rowShownOf({}, "minutes")).toBe(true);
    expect(rowShownOf(undefined, "volume")).toBe(true);
    expect(tipsShownOf({ showTips: true })).toBe(true);
    expect(tipsShownOf({ showTips: false })).toBe(false);
    expect(tipsShownOf({} as Pick<LiveRangeSettings, "showTips">)).toBe(true);
    expect(tipsShownOf(undefined)).toBe(true);
  });

  it("offers three monitor sizes in this order: Small, Medium, Large", () => {
    expect(CARD_SIZES).toEqual([["small", "Small"], ["medium", "Medium"], ["large", "Large"]]);
    expect(Object.isFrozen(CARD_SIZES)).toBe(true);
  });

  it("reads a known monitor size as it is and anything else as medium", () => {
    expect(cardSizeOf({ cardSize: "small" })).toBe("small");
    expect(cardSizeOf({ cardSize: "medium" })).toBe("medium");
    expect(cardSizeOf({ cardSize: "large" })).toBe("large");
    expect(cardSizeOf({ cardSize: "huge" as CardSize })).toBe("medium");
    expect(cardSizeOf({} as Pick<LiveRangeSettings, "cardSize">)).toBe("medium");
    expect(cardSizeOf(undefined)).toBe("medium");
  });

  it("reads a whole zone opacity from 1 to 50 percent as it is, and anything else as a tenth", () => {
    expect(zoneOpacityOf({ zoneOpacity: 1 })).toBe(1);
    expect(zoneOpacityOf({ zoneOpacity: 25 })).toBe(25);
    expect(zoneOpacityOf({ zoneOpacity: 50 })).toBe(50);
    expect(zoneOpacityOf({ zoneOpacity: 0 })).toBe(10);
    expect(zoneOpacityOf({ zoneOpacity: 51 })).toBe(10);
    expect(zoneOpacityOf({ zoneOpacity: 12.5 })).toBe(10);
    expect(zoneOpacityOf({ zoneOpacity: Number.NaN })).toBe(10);
    expect(zoneOpacityOf({} as Pick<LiveRangeSettings, "zoneOpacity">)).toBe(10);
    expect(zoneOpacityOf(undefined)).toBe(10);
  });

  it("shows the zone unless it was switched off", () => {
    expect(zoneShownOf({ showZone: true })).toBe(true);
    expect(zoneShownOf({ showZone: false })).toBe(false);
    expect(zoneShownOf({} as Pick<LiveRangeSettings, "showZone">)).toBe(true);
    expect(zoneShownOf(undefined)).toBe(true);
  });

  it("reads a known mode as it is and anything else as the visible range", () => {
    expect(rangeModeOf({ rangeMode: "visible" })).toBe("visible");
    expect(rangeModeOf({ rangeMode: "selected" })).toBe("selected");
    expect(rangeModeOf({ rangeMode: "live" })).toBe("live");
    expect(rangeModeOf({ rangeMode: "zone" as LiveRangeSettings["rangeMode"] })).toBe("visible");
    expect(rangeModeOf({} as Pick<LiveRangeSettings, "rangeMode">)).toBe("visible");
    expect(rangeModeOf(undefined)).toBe("visible");
  });

  it("scales the big print slider per kind of instrument: coins from 0.5 to 50, contracts from 1 to 300, shares from 100 to 50,000", () => {
    expect(CRYPTO_PRINT_SCALE).toEqual({ min: 0.5, max: 50, step: 0.5, fallback: 5 });
    expect(FUTURES_PRINT_SCALE).toEqual({ min: 1, max: 300, step: 1, fallback: 10 });
    expect(EQUITY_PRINT_SCALE).toEqual({ min: 100, max: 50_000, step: 100, fallback: 5_000 });
    expect([Object.isFrozen(CRYPTO_PRINT_SCALE), Object.isFrozen(FUTURES_PRINT_SCALE), Object.isFrozen(EQUITY_PRINT_SCALE)]).toEqual([true, true, true]);
  });

  it("gives a crypto pair the coin scale, an equity the share scale and any other instrument the contract scale, as its sizes are named", () => {
    expect(printScaleFor({ provider: "BINANCE" })).toBe(CRYPTO_PRINT_SCALE);
    expect(printScaleFor({ provider: "BINANCE", assetClass: "FUTURE" })).toBe(CRYPTO_PRINT_SCALE);
    expect(printScaleFor({ provider: "DXFEED", assetClass: "FUTURE" })).toBe(FUTURES_PRINT_SCALE);
    expect(printScaleFor({ provider: "DXFEED", assetClass: "EQUITY" })).toBe(EQUITY_PRINT_SCALE);
    expect(printScaleFor({ provider: "DATABENTO", assetClass: "EQUITY" })).toBe(EQUITY_PRINT_SCALE);
    expect(printScaleFor({ provider: "DATABENTO", assetClass: "FUTURE" })).toBe(FUTURES_PRINT_SCALE);
    expect(printScaleFor({ provider: "DXFEED" })).toBe(FUTURES_PRINT_SCALE);
  });

  it("reads the big print on its slider's steps and inside its bounds, and the instrument's own default when none was chosen", () => {
    expect(bigPrintOf({ bigPrint: 0 }, CRYPTO_PRINT_SCALE)).toBe(5);
    expect(bigPrintOf({ bigPrint: 0 }, FUTURES_PRINT_SCALE)).toBe(10);
    expect(bigPrintOf({ bigPrint: 0 }, EQUITY_PRINT_SCALE)).toBe(5_000);
    expect(bigPrintOf({ bigPrint: -3 }, CRYPTO_PRINT_SCALE)).toBe(5);
    expect(bigPrintOf({ bigPrint: Number.NaN }, CRYPTO_PRINT_SCALE)).toBe(5);
    expect(bigPrintOf({ bigPrint: Number.POSITIVE_INFINITY }, CRYPTO_PRINT_SCALE)).toBe(5);
    expect(bigPrintOf({ bigPrint: "2" as unknown as number }, CRYPTO_PRINT_SCALE)).toBe(5);
    expect(bigPrintOf(undefined, FUTURES_PRINT_SCALE)).toBe(10);
    expect(bigPrintOf({ bigPrint: 2.5 }, CRYPTO_PRINT_SCALE)).toBe(2.5);
    expect(bigPrintOf({ bigPrint: 2.7 }, CRYPTO_PRINT_SCALE)).toBe(2.5);
    expect(bigPrintOf({ bigPrint: 2.8 }, CRYPTO_PRINT_SCALE)).toBe(3);
    expect(bigPrintOf({ bigPrint: 0.1 }, CRYPTO_PRINT_SCALE)).toBe(0.5);
    expect(bigPrintOf({ bigPrint: 80 }, CRYPTO_PRINT_SCALE)).toBe(50);
    expect(bigPrintOf({ bigPrint: 12.4 }, FUTURES_PRINT_SCALE)).toBe(12);
    expect(bigPrintOf({ bigPrint: 0.4 }, FUTURES_PRINT_SCALE)).toBe(1);
    expect(bigPrintOf({ bigPrint: 5_000 }, FUTURES_PRINT_SCALE)).toBe(300);
    expect(bigPrintOf({ bigPrint: 5_049 }, EQUITY_PRINT_SCALE)).toBe(5_000);
    expect(bigPrintOf({ bigPrint: 5_050 }, EQUITY_PRINT_SCALE)).toBe(5_100);
    expect(bigPrintOf({ bigPrint: 5 }, EQUITY_PRINT_SCALE)).toBe(100);
    expect(bigPrintOf({ bigPrint: 90_000 }, EQUITY_PRINT_SCALE)).toBe(50_000);
    expect(bigPrintOf({ bigPrint: 0.3 }, { min: 0.1, max: 1, step: 0.1, fallback: 0.5 })).toBe(0.3);
  });
});
