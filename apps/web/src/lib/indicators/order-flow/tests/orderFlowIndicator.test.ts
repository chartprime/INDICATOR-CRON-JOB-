import { describe, expect, it } from "vitest";
import { orderFlowIndicator, DEFAULT_ORDER_FLOW_INDICATOR_SETTINGS } from "../orderFlowIndicator";

describe("orderFlowIndicator -- TA.04, registers Order Flow with the new authoring core to extend SettingsFieldSchema's proof", () => {
  it("is registered as a runtime indicator with a real settings schema, matching the original legacy entry's identity", () => {
    expect(orderFlowIndicator.kind).toBe("runtime");
    expect(orderFlowIndicator.id).toBe("orderFlow");
    expect(orderFlowIndicator.label).toBe("Aggressive Order Flow");
    expect(orderFlowIndicator.category).toBe("l1");
    expect(orderFlowIndicator.settingsSchema).toBeDefined();
  });

  it("defaults to line display", () => {
    expect(DEFAULT_ORDER_FLOW_INDICATOR_SETTINGS.displayMode).toBe("line");
  });

  it("onBar/readOutput are intentionally inert -- CVD is computed directly from bars/delta in ChartPanel.tsx's own recomputeIndicators, never from ctx.bar", () => {
    const state = orderFlowIndicator.createState(DEFAULT_ORDER_FLOW_INDICATOR_SETTINGS);
    expect(() =>
      orderFlowIndicator.onBar({
        bar: { ts_open: 0 } as never,
        trades: [],
        tradeAvailability: "HISTORICAL_UNAVAILABLE",
        state,
        settings: DEFAULT_ORDER_FLOW_INDICATOR_SETTINGS,
        replace: false,
        replaying: true,
        ta: {},
        draw: { fill: () => {} },
        markers: { plotshape: () => {}, plotchar: () => {} },
        pane: { paneIndex: 0 },
      }),
    ).not.toThrow();
    expect(orderFlowIndicator.readOutput(state)).toEqual({});
  });

  it("has no line outputs -- the line/histogram/candlestick series stay owned directly by ChartPanel.tsx, since the generic per-indicator series creation only ever builds a LineSeries", () => {
    expect(orderFlowIndicator.lines).toEqual([]);
  });
});
