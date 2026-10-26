import { describe, expect, it } from "vitest";
import { vpinCloudIndicator } from "../vpinCloudIndicator";

describe("vpinCloudIndicator -- TA.04, minimal lifecycle registration only", () => {
  it("is registered as a runtime indicator, matching the original legacy entry's identity", () => {
    expect(vpinCloudIndicator.kind).toBe("runtime");
    expect(vpinCloudIndicator.id).toBe("vpinCloud");
    expect(vpinCloudIndicator.label).toBe("VPIN Cloud");
    expect(vpinCloudIndicator.category).toBe("l1");
  });

  it("deliberately has no settingsSchema -- the sensitivity default is derived live per instrument, and its hint text embeds that live number, which a static schema (defined once, at module load) cannot express", () => {
    expect(vpinCloudIndicator.settingsSchema).toBeUndefined();
  });

  it("onBar/readOutput are intentionally inert -- the glow animation is a plain wall-clock setInterval in ChartPanel.tsx, entirely outside onBar", () => {
    const state = vpinCloudIndicator.createState({});
    expect(() =>
      vpinCloudIndicator.onBar({
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
    expect(vpinCloudIndicator.readOutput(state)).toEqual({});
  });

  it("has no line outputs -- rendering is the unchanged VpinCloudPrimitive, not ctx.draw/ctx.markers", () => {
    expect(vpinCloudIndicator.lines).toEqual([]);
  });
});
