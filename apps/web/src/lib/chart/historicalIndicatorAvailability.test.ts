import { describe, expect, it } from "vitest";
import type { HistoricalIndicatorCapability } from "../archive/historicalIndicatorSeries";
import {
  CANDLE_FLOW_INDICATOR_IDS,
  HISTORICAL_INDICATOR_POLICIES,
  INDICATOR_REGISTRY,
  historicalIndicatorAvailability,
} from "./indicatorRegistry";

describe("historical indicator availability", () => {
  it("enables Book Map and Feed Status from verified historical states; wall studies still require their own evidence", () => {
    const capabilities = new Set<HistoricalIndicatorCapability>(["ohlcv", "l2_states"]);
    expect(historicalIndicatorAvailability("l2BookMap", capabilities, "DATABENTO").available).toBe(true);
    expect(historicalIndicatorAvailability("l2FeedStatus", capabilities, "DATABENTO").available).toBe(true);
    expect(historicalIndicatorAvailability("l2FeedStatus", new Set(["ohlcv"]), "DATABENTO").available).toBe(false);
    for (const id of ["l2SupportResistance", "absorptionDetector", "institutionalOrderBlocksV2"] as const) {
      expect(historicalIndicatorAvailability(id, capabilities, "DATABENTO").available).toBe(false);
    }
  });
  it("declares one policy for every registered indicator and no orphan policy", () => {
    expect(Object.keys(HISTORICAL_INDICATOR_POLICIES).sort()).toEqual(
      INDICATOR_REGISTRY.map((indicator) => indicator.id).sort(),
    );
  });

  it("permits portable studies on OHLCV while refusing candle-flow studies without classified volume", () => {
    const ohlcv = new Set(["ohlcv"] as const);
    expect(historicalIndicatorAvailability("rsi", ohlcv, "DATABENTO")).toEqual({
      available: true,
      reason: null,
    });
    expect(
      historicalIndicatorAvailability("marketStructure", ohlcv, "DATABENTO"),
    ).toEqual({ available: true, reason: null });
    expect(
      historicalIndicatorAvailability("orderFlow", ohlcv, "BINANCE"),
    ).toEqual({
      available: false,
      reason: "Requires buy volume from every candle in the selected range.",
    });
  });

  it("opens the candle-flow studies for any provider that supplies a per-bar side split", () => {
    // Report 54 phase 4: the gate is the data, not the provider. Databento
    // candles carry no split, so the archive's bar_flow study supplies one from
    // trade_minute_1m; where it has not arrived the study stays closed.
    const flow = new Set(["ohlcv", "buy_volume"] as const);
    for (const provider of ["BINANCE", "DATABENTO"] as const) {
      for (const id of CANDLE_FLOW_INDICATOR_IDS) {
        expect(historicalIndicatorAvailability(id, flow, provider)).toEqual({
          available: true,
          reason: null,
        });
      }
    }
    expect(
      historicalIndicatorAvailability(
        "orderFlow",
        new Set(["ohlcv"]),
        "DATABENTO",
      ),
    ).toEqual({
      available: false,
      reason: "Requires buy volume from every candle in the selected range.",
    });
  });

  it("names the candle-flow studies the bar side split unlocks", () => {
    expect([...CANDLE_FLOW_INDICATOR_IDS].sort()).toEqual([
      "cvdDivergence",
      "deltaDivergence",
      "fvgBoxes",
      "fvgDelta",
      "liveDeltaProfile",
      "orderFlow",
      "sessionDeltaProfile",
      "volumeDeltaProfileOhlc",
      "volumeDeltaProfileTick",
    ]);
  });

  it("opens the trade-derived studies exactly when the archive serves trade families", () => {
    const candlesOnly = new Set(["ohlcv", "trade_count"] as const);
    const withFamilies = new Set([
      "ohlcv",
      "trade_count",
      "trade_families",
    ] as const);
    // Volume Profile, Net Delta Profile and Delta Profile are one indicator
    // now -- Session Volume Profile -- which renders the same server profile
    // frames, so it shares the trade-family rule they all had.
    for (const id of [
      "sessionVolumeProfile",
      "vpinCloud",
      "largeTradeDetector",
    ] as const) {
      expect(
        historicalIndicatorAvailability(id, candlesOnly, "DATABENTO"),
      ).toEqual({
        available: false,
        reason:
          "Needs archived trade summaries verified for this instrument and catalog snapshot.",
      });
      expect(
        historicalIndicatorAvailability(id, withFamilies, "DATABENTO"),
      ).toEqual({ available: true, reason: null });
    }
    expect(
      historicalIndicatorAvailability(
        "largeTradeBubbles",
        withFamilies,
        "DATABENTO",
      ),
    ).toEqual({
      available: false,
      reason:
        "Needs every trade in each bar; the archive keeps only the largest prints of each minute.",
    });
  });

  it("does not call unavailable historical inputs a disabled calculation", () => {
    const available = historicalIndicatorAvailability(
      "absorptionDetector",
      new Set(["ohlcv"]),
    );
    expect(available).toEqual({
      available: false,
      reason:
        "Needs published, verified historical L2 states for this instrument. Zoom to an available August 2026 hour.",
    });
  });
});
