// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultLiveIndicatorExtras,
  DEFAULT_WHALE_SETTINGS,
  LIVE_INDICATOR_EXTRAS_STORAGE_KEY,
  MAX_KEYED_ENTRIES,
  loadLiveIndicatorExtras,
  saveLiveIndicatorExtras,
  type LiveIndicatorExtras,
} from "../liveIndicatorExtras";
import { LIVE_INDICATOR_PREFERENCES_STORAGE_KEY, HISTORICAL_INDICATOR_PREFERENCES_STORAGE_KEY } from "../historicalIndicatorPreferences";
import { DEFAULT_L2_BOOK_MAP_SETTINGS } from "../../indicators/l2-book-map/l2BookMapPrimitive";
import { DEFAULT_WHALE_SETTINGS as DEFAULT_WHALE_HEATMAP_SETTINGS } from "../../indicators/whale-limit-order-heatmap/whaleSettings";
import { DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS } from "../../indicators/l2-support-resistance/l2SupportResistancePrimitive";
import { DEFAULT_LIQUIDITY_SETTINGS } from "../../indicators/passive-liquidity/liquiditySettings";
import { DEFAULT_AGGRESSIVE_ORDERS_SETTINGS } from "../../indicators/aggressive-orders/aggressiveOrdersSettings";
import { DEFAULT_LIVE_DELTA_PROFILE_SETTINGS } from "../../indicators/live-delta-profile/liveDeltaProfileSettings";
import { DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS } from "../../indicators/live-order-book-profile/liveOrderBookProfileSettings";
import { DEFAULT_AGGRESSIVE_PROFILE_SETTINGS } from "../../indicators/aggressive-orders-profile/aggressiveProfileSettings";
import { DEFAULT_ABSORPTION_SETTINGS, type AbsorptionSettings } from "../../indicators/absorption-detector/absorptionSettings";
import { DEFAULT_ICEBERG_SETTINGS } from "../../indicators/iceberg-detector/icebergSettings";
import { DEFAULT_EXHAUSTION_SETTINGS } from "../../indicators/exhaustion/exhaustionSettings";
import { DEFAULT_INITIATIVE_SETTINGS } from "../../indicators/initiative/initiativeSettings";
import { DEFAULT_LIVE_RANGE_SETTINGS } from "../../indicators/live-range-control/liveRangeSettings";

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

const EDITED: LiveIndicatorExtras = {
  l2SupportResistance: { ...DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS, maxLevels: 7, bidColor: "#123456" },
  l2BookMap: { ...DEFAULT_L2_BOOK_MAP_SETTINGS, priceBinRows: 9, showProfile: false },
  whaleHeatmap: { ...DEFAULT_WHALE_HEATMAP_SETTINGS, cutPreset: 3, cutBasis: "ratio", sideFilter: "ask", liveView: "rays", outcomeMask: 0b11111, hours: 168, thickness: 5, labels: false },
  liquidityByStyle: { crypto: { ...DEFAULT_LIQUIDITY_SETTINGS, clusterRows: 5, levelFilter: "resting", scaleMode: "fixed" } },
  liquidityLane: "1",
  aggressiveByInstrument: { "BINANCE|SPOT|BTCUSDT": { ...DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, minVolume: 3, showSellers: false } },
  absorptionByInstrument: { "BINANCE|SPOT|BTCUSDT": { ...DEFAULT_ABSORPTION_SETTINGS, opacity: 0.4, showBroken: false } },
  icebergByInstrument: { "DXFEED|FUTURE|/NQZ26:XCME": { ...DEFAULT_ICEBERG_SETTINGS, historyDays: 3, showPulled: true, markScale: 1.5 } },
  exhaustionByInstrument: { "BINANCE|SPOT|BTCUSDT": { ...DEFAULT_EXHAUSTION_SETTINGS, opacity: 0.4, historyDays: 3, buyerColor: "#112233" } },
  initiativeByInstrument: { "BINANCE|SPOT|BTCUSDT": { ...DEFAULT_INITIATIVE_SETTINGS, opacity: 0.4, minScore: 4, showShade: false, buyerColor: "#112233" } },
  liveRangeByInstrument: { "BINANCE|SPOT|BTCUSDT": { ...DEFAULT_LIVE_RANGE_SETTINGS, bidColor: "#123456", askColor: "#654321" } },
  liveDeltaByInstrument: { "BINANCE|SPOT|BTCUSDT": { ...DEFAULT_LIVE_DELTA_PROFILE_SETTINGS, rowFactor: 4, showNumbers: false } },
  liveOrderBookByInstrument: { "BINANCE|SPOT|BTCUSDT": { ...DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS, rowFactor: 2, askColor: "#654321" } },
  aggressiveProfileByInstrument: { "BINANCE|SPOT|BTCUSDT": { ...DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, floor: 12, buyColor: "#112233" } },
  whale: { ...DEFAULT_WHALE_SETTINGS, mode: "size", thresholdUsd: 120_000, clusterMode: "buySell" },
  vpinSensitivity: 2.5,
};

describe("live indicator extras (L-W4-6 remainder, report 57 W6)", () => {
  it("brings every custom indicator setting back after a reload", () => {
    saveLiveIndicatorExtras(EDITED);
    expect(loadLiveIndicatorExtras()).toEqual(EDITED);
  });

  it("keeps an Exhaustion entry saved with every key, the defaults included, and leaves one missing any key out: no shipped build saved an entry without its colours, so nothing migrates them", () => {
    const full = EDITED.exhaustionByInstrument["BINANCE|SPOT|BTCUSDT"];
    const { buyerColor: _buyer, sellerColor: _seller, ...withoutColours } = full;
    const { opacity: _opacity, ...bare } = full;
    localStorage.setItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY, JSON.stringify({ ...EDITED, exhaustionByInstrument: { chosen: full, defaults: DEFAULT_EXHAUSTION_SETTINGS, withoutColours, bare } }));
    const loaded = loadLiveIndicatorExtras().exhaustionByInstrument;
    expect(loaded.chosen).toEqual(full);
    expect(loaded.defaults).toEqual(DEFAULT_EXHAUSTION_SETTINGS);
    expect(loaded.withoutColours).toBeUndefined();
    expect(loaded.bare).toBeUndefined();
  });

  it("keeps heatmap settings saved before the History reach existed, at one day", () => {
    const { historyDays: _dropped, ...older } = DEFAULT_LIQUIDITY_SETTINGS;
    void _dropped;
    localStorage.setItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY, JSON.stringify({ liquidityByStyle: { "btc-perp": { ...older, clusterRows: 10 } } }));
    const restored = loadLiveIndicatorExtras();
    expect(restored.liquidityByStyle["btc-perp"]).toMatchObject({ clusterRows: 10, historyDays: 1 });
  });

  it("keeps heatmap settings saved before the higher-timeframe slider existed, at auto", () => {
    const { timeframeWidening: _dropped, ...older } = DEFAULT_LIQUIDITY_SETTINGS;
    void _dropped;
    localStorage.setItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY, JSON.stringify({ liquidityByStyle: { nq: { ...older, clusterRows: 8 } } }));
    const restored = loadLiveIndicatorExtras();
    expect(restored.liquidityByStyle.nq).toMatchObject({ clusterRows: 8, timeframeWidening: 1 });
  });

  it("keeps heatmap settings saved before the price-zoom choice existed, and reads a missing or unknown choice as the finest rows, the standard for every market", () => {
    const { liquidityLane: _dropped, ...older } = EDITED;
    localStorage.setItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY, JSON.stringify(older));
    const loaded = loadLiveIndicatorExtras();
    expect(loaded.liquidityByStyle).toEqual(EDITED.liquidityByStyle);
    expect(loaded.liquidityLane).toBe("0");
    localStorage.setItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY, JSON.stringify({ ...older, liquidityLane: "9" }));
    expect(loadLiveIndicatorExtras().liquidityLane).toBe("0");
    localStorage.setItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY, JSON.stringify({ ...older, liquidityLane: "auto" }));
    expect(loadLiveIndicatorExtras().liquidityLane).toBe("auto");
    expect(defaultLiveIndicatorExtras().liquidityLane).toBe("0");
  });

  it("drops the spheres' source an old session saved with the absorption settings, now that the trial is gone", () => {
    const { source: _dropped, ...older } = EDITED.absorptionByInstrument["BINANCE|SPOT|BTCUSDT"] as AbsorptionSettings & { source?: string };
    localStorage.setItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY, JSON.stringify({ ...EDITED, absorptionByInstrument: { old: older, both: { ...older, source: "both" }, odd: { ...older, source: "columns" } } }));
    expect(loadLiveIndicatorExtras().absorptionByInstrument).toEqual({ old: older, both: older, odd: older });
  });

  it("gives an absorption entry saved before the marks had a shape circles, keeps a chosen shape, and drops an entry with a shape that is not one", () => {
    const { shape: _shape, ...older } = EDITED.absorptionByInstrument["BINANCE|SPOT|BTCUSDT"];
    localStorage.setItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY, JSON.stringify({ ...EDITED, absorptionByInstrument: { old: older, chosen: { ...older, shape: "square" }, odd: { ...older, shape: "blob" } } }));
    expect(loadLiveIndicatorExtras().absorptionByInstrument).toEqual({ old: { ...older, shape: "circle" }, chosen: { ...older, shape: "square" } });
  });

  it("keeps an absorption entry saved before History existed at one day, carries hours saved before the reaches over as the nearest reach, off staying off; the floors an older rule saved are let go (PR #47 review)", () => {
    const { historyDays: _days, ...older } = EDITED.absorptionByInstrument["BINANCE|SPOT|BTCUSDT"];
    localStorage.setItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY, JSON.stringify({ ...EDITED, absorptionByInstrument: {
      old: { ...older, floors: { "1m": 90, "5m": 300 } },
      standard: { ...older, historyHours: 48 },
      hours: { ...older, historyHours: 72 },
      week: { ...older, historyHours: 168 },
      off: { ...older, historyHours: 0 },
      chosen: { ...older, historyHours: 168, historyDays: 1 },
      odd: { ...older, floors: { "1m": "ninety", "5m": 300, x: -1 } },
    } }));
    const loaded = loadLiveIndicatorExtras().absorptionByInstrument;
    expect(loaded.old).toEqual({ ...older, historyDays: 1 });
    expect(loaded.standard).toEqual({ ...older, historyDays: 1 });
    expect(loaded.hours).toEqual({ ...older, historyDays: 3 });
    expect(loaded.week).toEqual({ ...older, historyDays: 7 });
    expect(loaded.off).toEqual({ ...older, historyDays: 0 });
    expect(loaded.chosen).toEqual({ ...older, historyDays: 1 });
    expect(loaded.odd).toEqual({ ...older, historyDays: 1 });
  });

  it("gives an absorption entry saved before the rule's three numbers existed their defaults, and keeps chosen ones", () => {
    const { absorbedPercent: _share, strongPercent: _strong, absorbedMultiple: _multiple, ...bare } = EDITED.absorptionByInstrument["BINANCE|SPOT|BTCUSDT"];
    localStorage.setItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY, JSON.stringify({ ...EDITED, absorptionByInstrument: {
      before: bare,
      chosen: { ...bare, absorbedPercent: 250, strongPercent: 600, absorbedMultiple: 65 },
      odd: { ...bare, absorbedPercent: "lots" },
    } }));
    const loaded = loadLiveIndicatorExtras().absorptionByInstrument;
    expect(loaded.before).toEqual({ ...bare, absorbedPercent: 200, strongPercent: 300, absorbedMultiple: 40 });
    expect(loaded.chosen).toEqual({ ...bare, absorbedPercent: 250, strongPercent: 600, absorbedMultiple: 65 });
    expect(loaded.odd).toBeUndefined();
  });

  it("keeps an iceberg entry saved before the shape choice existed on auto, and drops one with a shape it does not know", () => {
    const { markShape: _shape, ...older } = EDITED.icebergByInstrument["DXFEED|FUTURE|/NQZ26:XCME"];
    localStorage.setItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY, JSON.stringify({ ...EDITED, icebergByInstrument: { old: older, chosen: { ...older, markShape: "triangle" }, odd: { ...older, markShape: "hexagon" } } }));
    const loaded = loadLiveIndicatorExtras().icebergByInstrument;
    expect(loaded.old).toEqual({ ...older, markShape: "auto" });
    expect(loaded.chosen).toEqual({ ...older, markShape: "triangle" });
    expect(loaded.odd).toBeUndefined();
  });

  it("keeps an iceberg entry saved before the placement choice existed at the price, brings back a chosen placement, and drops one it does not know", () => {
    const { placement: _placement, ...older } = EDITED.icebergByInstrument["DXFEED|FUTURE|/NQZ26:XCME"];
    localStorage.setItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY, JSON.stringify({ ...EDITED, icebergByInstrument: { old: older, chosen: { ...older, placement: "candle" }, odd: { ...older, placement: 7 } } }));
    const loaded = loadLiveIndicatorExtras().icebergByInstrument;
    expect(loaded.old).toEqual({ ...older, placement: "price" });
    expect(loaded.chosen).toEqual({ ...older, placement: "candle" });
    expect(loaded.odd).toBeUndefined();
  });

  it("brings back an iceberg entry with each mark shape the dialog offers, and with auto", () => {
    const saved = EDITED.icebergByInstrument["DXFEED|FUTURE|/NQZ26:XCME"];
    for (const markShape of ["auto", "dot", "triangle", "circle"] as const) {
      localStorage.setItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY, JSON.stringify({ ...EDITED, icebergByInstrument: { one: { ...saved, markShape } } }));
      expect(loadLiveIndicatorExtras().icebergByInstrument.one).toEqual({ ...saved, markShape });
    }
  });

  it("keeps an iceberg entry saved before the size slider existed, at the standard share", () => {
    const { sizeTopPercent: _top, ...older } = EDITED.icebergByInstrument["DXFEED|FUTURE|/NQZ26:XCME"];
    localStorage.setItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY, JSON.stringify({ ...EDITED, icebergByInstrument: { old: older, chosen: { ...older, sizeTopPercent: 25 } } }));
    const loaded = loadLiveIndicatorExtras().icebergByInstrument;
    expect(loaded.old).toEqual({ ...older, sizeTopPercent: 20 });
    expect(loaded.chosen).toEqual({ ...older, sizeTopPercent: 25 });
  });

  it("an iceberg entry saved under an older revision, or none, falls back to the standard settings; the current revision is kept", () => {
    const saved = EDITED.icebergByInstrument["DXFEED|FUTURE|/NQZ26:XCME"];
    const { revision: _revision, ...unversioned } = saved;
    localStorage.setItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY, JSON.stringify({ ...EDITED, icebergByInstrument: { older: { ...saved, revision: 1 }, none: unversioned, current: saved } }));
    const loaded = loadLiveIndicatorExtras().icebergByInstrument;
    expect(loaded.older).toBeUndefined();
    expect(loaded.none).toBeUndefined();
    expect(loaded.current).toEqual(saved);
  });

  it("starts from defaults when nothing is stored or the stored text is not JSON", () => {
    expect(loadLiveIndicatorExtras().whale).toEqual(DEFAULT_WHALE_SETTINGS);
    localStorage.setItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY, "{not json");
    const loaded = loadLiveIndicatorExtras();
    expect(loaded.l2BookMap).toEqual(DEFAULT_L2_BOOK_MAP_SETTINGS);
    expect(loaded.vpinSensitivity).toBeNull();
  });

  it("keeps each valid field of a single indicator and resets only the broken ones", () => {
    localStorage.setItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY, JSON.stringify({
      l2BookMap: { priceBinRows: 9, showProfile: "no", windowBuckets: -5 },
      whale: { mode: "loud", thresholdUsd: 90_000, topFraction: "x" },
    }));
    const loaded = loadLiveIndicatorExtras();
    expect(loaded.l2BookMap.priceBinRows).toBe(9);
    expect(loaded.l2BookMap.showProfile).toBe(DEFAULT_L2_BOOK_MAP_SETTINGS.showProfile);
    expect(loaded.l2BookMap.windowBuckets).toBe(DEFAULT_L2_BOOK_MAP_SETTINGS.windowBuckets);
    expect(loaded.whale).toEqual({ ...DEFAULT_WHALE_SETTINGS, thresholdUsd: 90_000 });
  });

  it("restores the whale heatmap's choices field by field, keeping the good ones and defaulting the rest, and defaults it for a session saved before it existed", () => {
    expect(loadLiveIndicatorExtras().whaleHeatmap).toEqual(DEFAULT_WHALE_HEATMAP_SETTINGS);
    localStorage.setItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY, JSON.stringify({ whaleHeatmap: { cutPreset: 3, liveView: "dom", thickness: "x", outcomeMask: -1, sideFilter: "bid", hours: 7 } }));
    expect(loadLiveIndicatorExtras().whaleHeatmap).toEqual({ ...DEFAULT_WHALE_HEATMAP_SETTINGS, cutPreset: 3, sideFilter: "bid" });
    const { whaleHeatmap: _dropped, ...older } = EDITED;
    localStorage.setItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY, JSON.stringify(older));
    expect(loadLiveIndicatorExtras().whaleHeatmap).toEqual(DEFAULT_WHALE_HEATMAP_SETTINGS);
  });

  it("drops a per-instrument or per-style entry that is incomplete or invalid, so that market falls back to its own defaults", () => {
    localStorage.setItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY, JSON.stringify({
      liquidityByStyle: {
        crypto: { ...DEFAULT_LIQUIDITY_SETTINGS, levelFilter: "sometimes" },
        index: { clusterRows: 4 },
        equity: { ...DEFAULT_LIQUIDITY_SETTINGS, clusterRows: 3 },
      },
      aggressiveByInstrument: { "BINANCE|SPOT|BTCUSDT": { ...DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, minVolume: Number.NaN } },
    }));
    const loaded = loadLiveIndicatorExtras();
    expect(Object.keys(loaded.liquidityByStyle)).toEqual(["equity"]);
    expect(loaded.aggressiveByInstrument).toEqual({});
  });

  it("bounds the stored maps and refuses a VPIN sensitivity outside the slider's range", () => {
    const many = Object.fromEntries(Array.from({ length: MAX_KEYED_ENTRIES + 10 }, (_, index) => [`K${index}`, DEFAULT_ABSORPTION_SETTINGS]));
    localStorage.setItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY, JSON.stringify({ absorptionByInstrument: many, vpinSensitivity: 99 }));
    const loaded = loadLiveIndicatorExtras();
    expect(Object.keys(loaded.absorptionByInstrument)).toHaveLength(MAX_KEYED_ENTRIES);
    expect(loaded.vpinSensitivity).toBeNull();
  });

  it("uses its own storage key, apart from the live and historical preference keys", () => {
    expect(new Set([LIVE_INDICATOR_EXTRAS_STORAGE_KEY, LIVE_INDICATOR_PREFERENCES_STORAGE_KEY, HISTORICAL_INDICATOR_PREFERENCES_STORAGE_KEY]).size).toBe(3);
    saveLiveIndicatorExtras(EDITED);
    expect(localStorage.getItem(LIVE_INDICATOR_PREFERENCES_STORAGE_KEY)).toBeNull();
  });

  it("never throws when storage refuses to read or write", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    expect(() => saveLiveIndicatorExtras(EDITED)).not.toThrow();
    expect(loadLiveIndicatorExtras().whale).toEqual(DEFAULT_WHALE_SETTINGS);
  });
});
