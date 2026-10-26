// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INDICATOR_REGISTRY, historicalIndicatorAvailability } from "../../../chart/indicatorRegistry";
import { LIVE_INDICATOR_EXTRAS_STORAGE_KEY, loadLiveIndicatorExtras, saveLiveIndicatorExtras } from "../../../chart/liveIndicatorExtras";
import { aggressiveOrdersProfileIndicator } from "../aggressiveOrdersProfileIndicator";
import { DEFAULT_AGGRESSIVE_PROFILE_SETTINGS } from "../aggressiveProfileSettings";

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

describe("Aggressive Orders Profile in the registry", () => {
  it("is an L2 indicator listed after the Live Order Book Profile it sits beside", () => {
    expect(aggressiveOrdersProfileIndicator).toEqual({ kind: "legacy", id: "aggressiveOrdersProfile", label: "Aggressive Orders Profile", category: "l2" });
    const ids = INDICATOR_REGISTRY.map((def) => def.id);
    expect(ids.indexOf("aggressiveOrdersProfile")).toBe(ids.indexOf("liveOrderBookProfile") + 1);
    expect(ids).not.toContain("visibleRangeControl");
  });

  it("is not offered on a historical chart", () => {
    expect(historicalIndicatorAvailability("aggressiveOrdersProfile", new Set(["ohlcv", "l2_states", "l2_prints"]), "BINANCE")).toEqual({
      available: false,
      reason: "Requires the live heatmap's columns, which candle archives do not contain.",
    });
  });

  it("keeps its settings per instrument across a reload, fills the view, the running total and the highlight into an entry saved before them, and drops a broken entry", () => {
    const edited = { ...DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, floor: 12, buyColor: "#112233" };
    saveLiveIndicatorExtras({ ...loadLiveIndicatorExtras(), aggressiveProfileByInstrument: { "BINANCE:PERPETUAL:BTC-USDT": edited } });
    expect(loadLiveIndicatorExtras().aggressiveProfileByInstrument).toEqual({ "BINANCE:PERPETUAL:BTC-USDT": edited });

    localStorage.setItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY, JSON.stringify({
      aggressiveProfileByInstrument: {
        good: edited,
        bad: { ...edited, floor: "guess" },
        odd: { ...edited, profileView: "pie" },
        short: { floor: 1 },
        old: { floor: 3, buyColor: "#112233", sellColor: "#445566" },
      },
    }));
    expect(loadLiveIndicatorExtras().aggressiveProfileByInstrument).toEqual({ good: edited, old: { ...DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, floor: 3, buyColor: "#112233", sellColor: "#445566" } });
    expect(loadLiveIndicatorExtras().liveOrderBookByInstrument).toEqual({});
  });
});
