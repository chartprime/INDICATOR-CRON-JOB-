import { describe, expect, it } from "vitest";
import { whaleDetectorIndicator } from "../whaleDetectorIndicator";

describe("whaleDetectorIndicator -- TA.04, minimal lifecycle registration only", () => {
  it("is registered as a runtime indicator, keeping the original legacy entry's exact id (largeTradeDetector), distinct from TA.03.5's largeTradeBubbles proof-of-concept", () => {
    expect(whaleDetectorIndicator.kind).toBe("runtime");
    expect(whaleDetectorIndicator.id).toBe("largeTradeDetector");
    expect(whaleDetectorIndicator.label).toBe("Large Trade Detector");
    expect(whaleDetectorIndicator.category).toBe("l1");
  });

  it("deliberately has no settingsSchema -- log-range sliders have no schema field kind, and its hint text embeds live externally-computed values (resolvedThreshold, truncated) a static schema cannot receive", () => {
    expect(whaleDetectorIndicator.settingsSchema).toBeUndefined();
  });

  it("onBar/readOutput are intentionally inert -- marker stats are computed in MainPanel.tsx from live `markers`, never from ctx.bar", () => {
    const state = whaleDetectorIndicator.createState({});
    expect(() =>
      whaleDetectorIndicator.onBar({
        bar: { ts_open: 0 } as never,
        trades: [],
        tradeAvailability: "HISTORICAL_UNAVAILABLE",
        state,
        settings: {},
        replace: false,
        replaying: true,
        ta: {},
        draw: { fill: () => {} },
        markers: { plotshape: () => {}, plotchar: () => {} },
        pane: { paneIndex: 0 },
      }),
    ).not.toThrow();
    expect(whaleDetectorIndicator.readOutput(state)).toEqual({});
  });

  it("has no line outputs -- rendering (and its hit-test-driven hover tooltip) is the unchanged WhaleMarkersPrimitive, not ctx.draw/ctx.markers", () => {
    expect(whaleDetectorIndicator.lines).toEqual([]);
  });
});
