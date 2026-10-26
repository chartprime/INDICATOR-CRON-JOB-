// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INDICATOR_REGISTRY, historicalIndicatorAvailability } from "../../../chart/indicatorRegistry";
import { LIVE_INDICATOR_EXTRAS_STORAGE_KEY, loadLiveIndicatorExtras, saveLiveIndicatorExtras } from "../../../chart/liveIndicatorExtras";
import { liveRangeControlIndicator } from "../liveRangeControlIndicator";
import { DEFAULT_LIVE_RANGE_SETTINGS, type LiveRangeSettings } from "../liveRangeSettings";

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", storage());
});

describe("Live Range Control in the registry", () => {
  it("is an L2 indicator listed after Initiative Continuation", () => {
    expect(liveRangeControlIndicator).toEqual({ kind: "legacy", id: "liveRangeControl", label: "Live Range Control", category: "l2" });
    const ids = INDICATOR_REGISTRY.map((def) => def.id);
    expect(ids.indexOf("liveRangeControl")).toBe(ids.indexOf("initiative") + 1);
  });

  it("is not offered on a historical chart", () => {
    expect(historicalIndicatorAvailability("liveRangeControl", new Set(["ohlcv", "l2_states", "l2_prints"]), "BINANCE")).toEqual({
      available: false,
      reason: "Requires the live heatmap's columns, which candle archives do not contain.",
    });
  });

  it("keeps its settings per instrument across a reload, fills in the settings an older entry did not have, the monitor size, the zone tick, the zone opacity, the verdict sensitivity, the row ticks and the hover tips too, and drops a broken entry", () => {
    const edited: LiveRangeSettings = { ...DEFAULT_LIVE_RANGE_SETTINGS, rangeMode: "live", bigPrint: 12.5, verdictSensitivity: "strict", zoneColor: "#abcdef", zoneOpacity: 25, bidColor: "#112233", cardSize: "large", showZone: false, showDeltaRow: false, showTips: false };
    saveLiveIndicatorExtras({ ...loadLiveIndicatorExtras(), liveRangeByInstrument: { "BINANCE:PERPETUAL:BTC-USDT": edited } });
    expect(loadLiveIndicatorExtras().liveRangeByInstrument).toEqual({ "BINANCE:PERPETUAL:BTC-USDT": edited });

    localStorage.setItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY, JSON.stringify({
      liveRangeByInstrument: {
        good: edited,
        colours: { bidColor: "#112233", askColor: "#445566" },
        older: { widthPct: 0.5, historyHours: 4, zoneColor: "#abcdef", bidColor: "#112233", askColor: "#445566" },
        selected: { ...edited, rangeMode: "selected" },
        visible: { ...edited, rangeMode: "visible" },
        bad: { ...edited, askColor: 7 },
        unknownMode: { ...edited, rangeMode: "zone" },
        negative: { ...edited, bigPrint: -1 },
        short: { bidColor: "#112233" },
        beforeSize: { rangeMode: "live", bigPrint: 12.5, zoneColor: "#abcdef", bidColor: "#112233", askColor: "#445566" },
        small: { ...edited, cardSize: "small", showZone: true },
        medium: { ...edited, cardSize: "medium" },
        unknownSize: { ...edited, cardSize: "huge" },
        zoneWord: { ...edited, showZone: "no" },
        opacityWord: { ...edited, zoneOpacity: "soft" },
        beforeOpacity: { rangeMode: "live", bigPrint: 12.5, zoneColor: "#abcdef", bidColor: "#112233", askColor: "#445566", cardSize: "small", showZone: true },
        beforeRows: { rangeMode: "live", bigPrint: 12.5, zoneColor: "#abcdef", zoneOpacity: 25, bidColor: "#112233", askColor: "#445566", cardSize: "small", showZone: true },
        high: { ...edited, verdictSensitivity: "high", showVolumeRow: false, showPrintsRow: false, showMinutesRow: false, showImpactRow: false },
        unknownSensitivity: { ...edited, verdictSensitivity: "loose" },
        rowWord: { ...edited, showImpactRow: "yes" },
        tipsWord: { ...edited, showTips: 1 },
      },
    }));
    expect(loadLiveIndicatorExtras().liveRangeByInstrument).toEqual({
      good: edited,
      colours: { ...DEFAULT_LIVE_RANGE_SETTINGS, bidColor: "#112233", askColor: "#445566" },
      older: { ...DEFAULT_LIVE_RANGE_SETTINGS, zoneColor: "#abcdef", bidColor: "#112233", askColor: "#445566" },
      selected: { ...edited, rangeMode: "selected" },
      visible: { ...edited, rangeMode: "visible" },
      beforeSize: { ...DEFAULT_LIVE_RANGE_SETTINGS, rangeMode: "live", bigPrint: 12.5, zoneColor: "#abcdef", bidColor: "#112233", askColor: "#445566" },
      small: { ...edited, cardSize: "small", showZone: true },
      medium: { ...edited, cardSize: "medium" },
      beforeOpacity: { ...DEFAULT_LIVE_RANGE_SETTINGS, rangeMode: "live", bigPrint: 12.5, zoneColor: "#abcdef", bidColor: "#112233", askColor: "#445566", cardSize: "small", showZone: true },
      beforeRows: { ...DEFAULT_LIVE_RANGE_SETTINGS, rangeMode: "live", bigPrint: 12.5, zoneColor: "#abcdef", zoneOpacity: 25, bidColor: "#112233", askColor: "#445566", cardSize: "small", showZone: true },
      high: { ...edited, verdictSensitivity: "high", showVolumeRow: false, showPrintsRow: false, showMinutesRow: false, showImpactRow: false },
    });
    expect(loadLiveIndicatorExtras().initiativeByInstrument).toEqual({});
  });
});
