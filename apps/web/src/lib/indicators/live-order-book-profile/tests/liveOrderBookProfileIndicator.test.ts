// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INDICATOR_REGISTRY, historicalIndicatorAvailability } from "../../../chart/indicatorRegistry";
import { LIVE_INDICATOR_EXTRAS_STORAGE_KEY, loadLiveIndicatorExtras, saveLiveIndicatorExtras } from "../../../chart/liveIndicatorExtras";
import { liveOrderBookProfileIndicator } from "../liveOrderBookProfileIndicator";
import { DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS } from "../liveOrderBookProfileSettings";

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

describe("Live Order Book Profile in the registry", () => {
  it("is an L2 indicator drawn after the heatmap", () => {
    expect(liveOrderBookProfileIndicator).toEqual({ kind: "legacy", id: "liveOrderBookProfile", label: "Live Order Book Profile", category: "l2" });
    const ids = INDICATOR_REGISTRY.map((def) => def.id);
    expect(ids.indexOf("liveOrderBookProfile")).toBeGreaterThan(ids.indexOf("passiveLiquidity"));
  });

  it("refuses a historical chart without qualified depth", () => {
    expect(historicalIndicatorAvailability("liveOrderBookProfile", new Set(["ohlcv", "buy_volume", "trade_families"]), "BINANCE")).toEqual({
      available: false,
      reason: "Needs published, verified historical L2 states for this instrument. Zoom to an available August 2026 hour.",
    });
  });

  it("keeps its settings per instrument across a reload and drops a broken entry", () => {
    const edited = { ...DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS, rowFactor: 4, showNumbers: false, bidColor: "#112233" };
    saveLiveIndicatorExtras({ ...loadLiveIndicatorExtras(), liveOrderBookByInstrument: { "BINANCE:PERPETUAL:BTC-USDT": edited } });
    expect(loadLiveIndicatorExtras().liveOrderBookByInstrument).toEqual({ "BINANCE:PERPETUAL:BTC-USDT": edited });

    localStorage.setItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY, JSON.stringify({
      liveOrderBookByInstrument: { good: edited, bad: { ...edited, widthShare: "wide" }, short: { rowFactor: 1 } },
    }));
    expect(loadLiveIndicatorExtras().liveOrderBookByInstrument).toEqual({ good: edited });
    expect(loadLiveIndicatorExtras().liveDeltaByInstrument).toEqual({});
  });
});
