import { describe, expect, it } from "vitest";
import { deltaDivergenceIndicator, DEFAULT_DELTA_DIVERGENCE_INDICATOR_SETTINGS } from "../deltaDivergenceIndicator";

describe("deltaDivergenceIndicator -- TA.04, registers Delta Divergence with the new authoring core", () => {
  it("is registered as a runtime indicator with a real settings schema, matching the original legacy entry's identity", () => {
    expect(deltaDivergenceIndicator.kind).toBe("runtime");
    expect(deltaDivergenceIndicator.id).toBe("deltaDivergence");
    expect(deltaDivergenceIndicator.label).toBe("Delta Divergence");
    expect(deltaDivergenceIndicator.category).toBe("l1");
    expect(deltaDivergenceIndicator.settingsSchema).toBeDefined();
  });

  it("defaults swingLength to 3, matching the original bespoke modal's default", () => {
    expect(DEFAULT_DELTA_DIVERGENCE_INDICATOR_SETTINGS.swingLength).toBe(3);
  });

  it("no field declares a tab -- matches the original modal's flat (non-tabbed) layout", () => {
    expect(deltaDivergenceIndicator.settingsSchema!.every((field) => field.tab === undefined)).toBe(true);
  });

  it("the swingLength custom field declares its own settings key (TA.05 audit finding on the shared runtime's recompute detection)", () => {
    const customField = deltaDivergenceIndicator.settingsSchema!.find((field) => field.kind === "custom");
    expect(customField).toBeDefined();
    expect((customField as { key?: unknown }).key).toBe("swingLength");
  });

  it("onBar/readOutput are intentionally inert -- divergences are computed directly from bars/delta/cvd in ChartPanel.tsx's own recomputeIndicators, never from ctx.bar", () => {
    const state = deltaDivergenceIndicator.createState(DEFAULT_DELTA_DIVERGENCE_INDICATOR_SETTINGS);
    expect(() =>
      deltaDivergenceIndicator.onBar({
        bar: { ts_open: 0 } as never,
        trades: [],
        tradeAvailability: "HISTORICAL_UNAVAILABLE",
        state,
        settings: DEFAULT_DELTA_DIVERGENCE_INDICATOR_SETTINGS,
        replace: false,
        replaying: true,
        ta: {},
        draw: { fill: () => {} },
        markers: { plotshape: () => {}, plotchar: () => {} },
        pane: { paneIndex: 0 },
      }),
    ).not.toThrow();
    expect(deltaDivergenceIndicator.readOutput(state)).toEqual({});
  });

  it("has no line outputs, and no crossAttachments -- the CVD-pane attachment stays hand-wired directly in ChartPanel.tsx since RuntimeIndicatorDef.crossAttachments is declared but never consumed by any runtime code", () => {
    expect(deltaDivergenceIndicator.lines).toEqual([]);
    expect(deltaDivergenceIndicator.crossAttachments).toBeUndefined();
  });
});
