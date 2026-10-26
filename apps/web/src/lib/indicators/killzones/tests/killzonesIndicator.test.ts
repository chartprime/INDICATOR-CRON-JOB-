import { describe, expect, it } from "vitest";
import { killzonesIndicator, KILLZONE_MAX_INTERVAL_MS } from "../killzonesIndicator";

describe("killzonesIndicator -- TA.04, registers Killzones with the new authoring core to prove timeframeGate", () => {
  it("is registered as a runtime indicator under the session category, matching the original legacy entry's identity", () => {
    expect(killzonesIndicator.kind).toBe("runtime");
    expect(killzonesIndicator.id).toBe("killzones");
    expect(killzonesIndicator.label).toBe("ICT Killzones");
    expect(killzonesIndicator.category).toBe("session");
  });

  it("timeframeGate preserves the exact 30-minute threshold ChartPanel.tsx already enforced before this migration", () => {
    expect(KILLZONE_MAX_INTERVAL_MS).toBe(30 * 60_000);
    const gate = killzonesIndicator.timeframeGate!;
    expect(gate(60_000)).toBe(true); // 1m
    expect(gate(5 * 60_000)).toBe(true); // 5m
    expect(gate(30 * 60_000)).toBe(true); // 30m, inclusive
    expect(gate(60 * 60_000)).toBe(false); // 1h
    expect(gate(24 * 60 * 60_000)).toBe(false); // 1D
  });

  it("onBar/readOutput are intentionally inert -- rendering stays external, driven directly by ChartPanel.tsx", () => {
    const state = killzonesIndicator.createState({});
    expect(() =>
      killzonesIndicator.onBar({
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
    expect(killzonesIndicator.readOutput(state)).toEqual({});
  });

  it("has no line outputs -- creates no series, since its rendering is the unchanged bespoke KillzonesPrimitive, not ctx.draw/ctx.markers", () => {
    expect(killzonesIndicator.lines).toEqual([]);
  });
});
