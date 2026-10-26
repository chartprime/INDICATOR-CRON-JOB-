import { describe, expect, it } from "vitest";
import type { OrderCluster } from "../aggressiveTape";
import {
  BUBBLE_MAX_RADIUS_PX,
  BUBBLE_MIN_RADIUS_PX,
  DEFAULT_AGGRESSIVE_ORDERS_SETTINGS,
  bubbleRadius,
  clusterRulesFor,
  defaultAggressiveOrdersSettingsFor,
  describeGrouping,
  groupingOf,
  groupingStepFor,
  groupingWidthsFor,
  isAggressiveTimeframeSupported,
  linksToCandles,
  scaledClusterRules,
  widthMultiplierFor,
  sizeReferenceFor,
  suggestedClusterWidthFor,
  suggestedMinVolumeFor,
  visibleOrders,
} from "../aggressiveOrdersSettings";

const T = 1_700_000_000_000;
const order = (over: Partial<OrderCluster> = {}): OrderCluster => ({ ts: T, lastTs: T, fedAt: 0, price: 7600, lastPrice: 7600, minPrice: 7600, maxPrice: 7600, vwap: 7600, volume: 12, count: 1, side: "buy", ...over });

describe("aggressiveOrdersSettings", () => {
  it("sizes a bubble by area: four times the reference is twice the radius, clamped both ways", () => {
    expect(bubbleRadius(10, 10)).toBe(BUBBLE_MIN_RADIUS_PX);
    expect(bubbleRadius(40, 10)).toBeCloseTo(BUBBLE_MIN_RADIUS_PX * 2);
    expect(bubbleRadius(5, 10)).toBe(BUBBLE_MIN_RADIUS_PX); // under the reference stays visible at the floor size
    expect(bubbleRadius(1e9, 10)).toBe(BUBBLE_MAX_RADIUS_PX);
    expect(bubbleRadius(10, 0)).toBe(BUBBLE_MIN_RADIUS_PX); // no reference: the floor size
    expect(bubbleRadius(40, 10, 2)).toBeCloseTo(BUBBLE_MIN_RADIUS_PX * 4);
    expect(bubbleRadius(40, 10, 0)).toBeCloseTo(BUBBLE_MIN_RADIUS_PX * 2 * 0.1); // the scale never reaches zero
  });

  it("shows the sides the trader wants", () => {
    const orders = [order(), order({ side: "sell" })];
    expect(visibleOrders(orders, DEFAULT_AGGRESSIVE_ORDERS_SETTINGS)).toEqual(orders);
    expect(visibleOrders(orders, { ...DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, showBuyers: false })).toEqual([orders[1]]);
    expect(visibleOrders(orders, { ...DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, showSellers: false })).toEqual([orders[0]]);
  });

  it("suggests a big single order per instrument, in its own unit, and starts every instrument on the automatic floor", () => {
    expect(suggestedMinVolumeFor({ symbol: "/ESU26:XCME", provider: "DXFEED", assetClass: "FUTURE" })).toBe(10);
    expect(suggestedMinVolumeFor({ symbol: "/NQU26:XCME", provider: "DXFEED", assetClass: "FUTURE" })).toBe(5);
    expect(suggestedMinVolumeFor({ symbol: "NVDA", provider: "DXFEED", assetClass: "EQUITY" })).toBe(1000);
    expect(suggestedMinVolumeFor({ symbol: "MSFT", provider: "DXFEED", assetClass: "EQUITY" })).toBe(500);
    expect(suggestedMinVolumeFor({ symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL" })).toBe(1);
    expect(suggestedMinVolumeFor({ symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT" })).toBe(0.1);
    expect(suggestedMinVolumeFor({ symbol: "ETH-USDT", provider: "BINANCE", marketKind: "PERPETUAL" })).toBe(20);
    expect(suggestedMinVolumeFor({ symbol: "SOL-USDT", provider: "BINANCE", marketKind: "SPOT" })).toBe(0);
    // ES, the trader's standard of 2026-09-11: orders over 20, grouped Wide (four ticks), bubbles at 0.8.
    expect(defaultAggressiveOrdersSettingsFor({ symbol: "/ESU26:XCME", provider: "DXFEED", assetClass: "FUTURE" })).toEqual({ ...DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, minVolume: 20, sizeReference: 10, clusterWidth: 1, bubbleScale: 0.8 });
    // AAPL and TSLA, the trader's standards of 2026-09-11: orders from 1,000 and 2,000 shares, grouped Normal, bubbles at 0.6 and 0.7; NVDA stays automatic.
    expect(defaultAggressiveOrdersSettingsFor({ symbol: "AAPL", provider: "DXFEED", assetClass: "EQUITY" })).toMatchObject({ minVolume: 1_000, sizeReference: 500, bubbleScale: 0.6 });
    expect(defaultAggressiveOrdersSettingsFor({ symbol: "TSLA", provider: "DXFEED", assetClass: "EQUITY" })).toMatchObject({ minVolume: 2_000, sizeReference: 500, bubbleScale: 0.7 });
    expect(defaultAggressiveOrdersSettingsFor({ symbol: "NVDA", provider: "DXFEED", assetClass: "EQUITY" })).toMatchObject({ minVolume: 0, bubbleScale: 1 });
    // NQ, the trader's own chart, starts with its floor pinned at the big-order reference (2026-09-11); the others automatic.
    expect(defaultAggressiveOrdersSettingsFor({ symbol: "/NQU26:XCME", provider: "DXFEED", assetClass: "FUTURE" })).toEqual({ ...DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, minVolume: 5, sizeReference: 5, clusterWidth: 0.5 });
    expect(defaultAggressiveOrdersSettingsFor({ symbol: "SOL-USDT", provider: "BINANCE", marketKind: "SPOT" }).sizeReference).toBe(0);
    // BTC perp, the trader's standard of 2026-09-11: orders from 10 BTC, grouped Normal, bubbles at 0.8; BTC spot from 2 BTC, Normal, bubbles at 0.6.
    expect(defaultAggressiveOrdersSettingsFor({ symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL" })).toMatchObject({ minVolume: 10, bubbleScale: 0.8, clusterWidth: defaultAggressiveOrdersSettingsFor({ symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT" }).clusterWidth }); // Normal: the pair's own suggested width
    expect(defaultAggressiveOrdersSettingsFor({ symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT" })).toMatchObject({ minVolume: 2, bubbleScale: 0.6 });
    // ETH, the trader's standards of 2026-09-11: spot from 10 ETH with bubbles at 0.5, perp from 40 ETH at 0.8, both grouped Normal.
    expect(defaultAggressiveOrdersSettingsFor({ symbol: "ETH-USDT", provider: "BINANCE", marketKind: "SPOT" })).toMatchObject({ minVolume: 10, bubbleScale: 0.5 });
    expect(defaultAggressiveOrdersSettingsFor({ symbol: "ETH-USDT", provider: "BINANCE", marketKind: "PERPETUAL" })).toMatchObject({ minVolume: 40, bubbleScale: 0.8 });
    expect(suggestedClusterWidthFor({ symbol: "AAPL", provider: "DXFEED", assetClass: "EQUITY" })).toBe(0.02);
    expect(suggestedClusterWidthFor({ symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL" })).toBe(1);
    expect(suggestedClusterWidthFor({ symbol: "ETH-USDT", provider: "BINANCE", marketKind: "SPOT" })).toBe(0.1);
    expect(clusterRulesFor({ ...DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, minVolume: -1, clusterWidth: 0.5, clusterGapMs: 3000, clusterMaxMs: 10000 })).toEqual({ minVolume: 0, width: 0.5, gapMs: 3000, maxMs: 10000, bucketMs: 0 });
  });

  it("sizes against the instrument's reference, never the filter: a floor hides bubbles, it does not resize them", () => {
    const settings = { ...DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, sizeReference: 10 };
    expect(sizeReferenceFor(settings, 3)).toBe(10);
    expect(sizeReferenceFor({ ...settings, minVolume: 80 }, 3)).toBe(10);
    expect(sizeReferenceFor({ ...settings, sizeReference: 0 }, 3)).toBe(3); // no reference known: the tape's automatic floor
  });
  it("offers Off / Tight / Normal / Wide per product, one, two and four steps of the product's own unit", () => {
    const es = { symbol: "/ESU26:XCME", provider: "DXFEED" as const, assetClass: "FUTURE" as const };
    const nvda = { symbol: "NVDA", provider: "DXFEED" as const, assetClass: "EQUITY" as const };
    const btc = { symbol: "BTC-USDT", provider: "BINANCE" as const, marketKind: "PERPETUAL" as const };
    const eth = { symbol: "ETH-USDT", provider: "BINANCE" as const, marketKind: "SPOT" as const };
    const sol = { symbol: "SOL-USDT", provider: "BINANCE" as const, marketKind: "SPOT" as const };
    expect(groupingStepFor(es)).toEqual({ size: 0.25, unit: "tick" });
    expect(groupingStepFor(nvda)).toEqual({ size: 0.01, unit: "cent" });
    expect(groupingStepFor(btc)).toEqual({ size: 0.5, unit: "dollar" });
    expect(groupingStepFor(sol)).toBeNull();
    expect(groupingWidthsFor(es)).toEqual({ off: 0, tight: 0.25, normal: 0.5, wide: 1 });
    expect(groupingWidthsFor(nvda)).toEqual({ off: 0, tight: 0.01, normal: 0.02, wide: 0.04 });
    expect(groupingWidthsFor(btc)).toEqual({ off: 0, tight: 0.5, normal: 1, wide: 2 });
    expect(groupingWidthsFor(eth)).toEqual({ off: 0, tight: 0.05, normal: 0.1, wide: 0.2 });
    expect(groupingWidthsFor(sol)).toEqual({ off: 0, tight: 0, normal: 0, wide: 0 });
    expect(groupingOf(0.5, es)).toBe("normal");
    expect(groupingOf(0, es)).toBe("off");
    expect(groupingOf(0.75, es)).toBe("custom");
    expect(defaultAggressiveOrdersSettingsFor(btc).clusterWidth).toBe(1);
  });

  it("describes a grouping in the product's own words", () => {
    const es = { symbol: "/ESU26:XCME", provider: "DXFEED" as const, assetClass: "FUTURE" as const };
    const aapl = { symbol: "AAPL", provider: "DXFEED" as const, assetClass: "EQUITY" as const };
    const btc = { symbol: "BTC-USDT", provider: "BINANCE" as const, marketKind: "PERPETUAL" as const };
    const timing = { clusterGapMs: 3_000, clusterMaxMs: 10_000 };
    expect(describeGrouping("normal", 0.5, es, timing)).toBe("Same-side orders within 2 ticks (0.50) and 3 s of each other become one bubble. A bubble lives at most 10 s.");
    expect(describeGrouping("tight", 0.25, es, timing)).toContain("within 1 tick (0.25)");
    expect(describeGrouping("wide", 0.04, aapl, timing)).toContain("within 4 cents and 3 s");
    expect(describeGrouping("tight", 0.5, btc, timing)).toContain("within $0.50 and 3 s");
    expect(describeGrouping("custom", 0.75, es, { clusterGapMs: 2_500, clusterMaxMs: 10_000 })).toContain("within 3 ticks (0.75) and 2.5 s");
    expect(describeGrouping("off", 0, es, timing)).toMatch(/^Every order is its own bubble/);
  });
  it("scales the clustering with the candle: time linearly, price by its square root, both capped", () => {
    const es = { symbol: "/ESU26:XCME", provider: "DXFEED" as const, assetClass: "FUTURE" as const };
    const settings = { ...defaultAggressiveOrdersSettingsFor(es), minVolume: 0, clusterWidth: 0.5, bubbleScale: 1 }; // Normal: 0.5 (2 ticks), gap 3 s, life 10 s (ES now starts Wide at a floor of 20)
    const step = 0.25;
    const at = (minutes: number) => scaledClusterRules(settings, { intervalMs: minutes * 60000, step });

    // 1 and 5 minute charts run free, exactly as the trader reads them today.
    expect(at(1)).toEqual({ minVolume: 0, width: 0.5, gapMs: 3_000, maxMs: 10_000, bucketMs: 0 });
    expect(at(5)).toEqual({ minVolume: 0, width: 1, gapMs: 15_000, maxMs: 50_000, bucketMs: 0 }); // 4 ticks, 15 s, 50 s
    // From 15 minutes up a candle owns its bubbles: the candle is the gap, the life and the bucket.
    expect(at(15)).toEqual({ minVolume: 0, width: 2, gapMs: 15 * 60000, maxMs: 15 * 60000, bucketMs: 15 * 60000 }); // 8 ticks
    expect(at(60)).toEqual({ minVolume: 0, width: 2, gapMs: 60 * 60000, maxMs: 60 * 60000, bucketMs: 60 * 60000 }); // the width multiplier caps at 4x
    expect(at(240)).toMatchObject({ width: 2, bucketMs: 240 * 60000 });
    // A sub-minute chart is never tightened below what the settings say.
    expect(at(0.5)).toEqual(at(1));
    expect(linksToCandles(5 * 60000)).toBe(false);
    expect(linksToCandles(15 * 60000)).toBe(true);
    expect(linksToCandles(60 * 60000)).toBe(true);
    // Every product links the same way; only the price step is its own.
    for (const identity of [
      { symbol: "NVDA", provider: "DXFEED" as const, assetClass: "EQUITY" as const },
      { symbol: "BTC-USDT", provider: "BINANCE" as const, marketKind: "PERPETUAL" as const },
      { symbol: "ETH-USDT", provider: "BINANCE" as const, marketKind: "SPOT" as const },
      { symbol: "SOL-USDT", provider: "BINANCE" as const, marketKind: "SPOT" as const }, // no step known: width left unsnapped
    ]) {
      const own = defaultAggressiveOrdersSettingsFor(identity);
      const rules = scaledClusterRules(own, { intervalMs: 15 * 60000, step: groupingStepFor(identity)?.size ?? 0 });
      expect(rules.bucketMs).toBe(15 * 60000);
      expect(rules.gapMs).toBe(15 * 60000);
    }
    // Grouping off stays off at every timeframe, and the floor is never touched.
    const off = { ...settings, clusterWidth: 0, minVolume: 7 };
    expect(scaledClusterRules(off, { intervalMs: 15 * 60000, step }).width).toBe(0);
    expect(scaledClusterRules(off, { intervalMs: 15 * 60000, step }).minVolume).toBe(7);
    // Without a product step the width is left unsnapped.
    expect(scaledClusterRules(settings, { intervalMs: 5 * 60000 }).width).toBeCloseTo(0.5 * Math.sqrt(5));
    // Below the link threshold the free-running caps still bound a long quiet run.
    expect(at(14).gapMs).toBe(42_000);
    expect(at(14).bucketMs).toBe(0);
    // Defaults to a one-minute candle.
    expect(scaledClusterRules(settings)).toEqual(at(1));
    expect(widthMultiplierFor(60000)).toBe(1);
    expect(widthMultiplierFor(4 * 60000)).toBeCloseTo(2);
    expect(widthMultiplierFor(1_000 * 60000)).toBe(4);
  });

  it("draws nothing above a four-hour candle", () => {
    expect(isAggressiveTimeframeSupported(60000)).toBe(true);
    expect(isAggressiveTimeframeSupported(4 * 60 * 60000)).toBe(true);
    expect(isAggressiveTimeframeSupported(4 * 60 * 60000 + 1)).toBe(false);
    expect(isAggressiveTimeframeSupported(24 * 60 * 60000)).toBe(false);
    expect(isAggressiveTimeframeSupported(0)).toBe(false);
    expect(isAggressiveTimeframeSupported(Number.NaN)).toBe(false);
  });
});
