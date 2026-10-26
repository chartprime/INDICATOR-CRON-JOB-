import { describe, expect, it, vi } from "vitest";
import { SessionDeltaProfilePrimitive } from "./sessionDeltaProfilePrimitive";
import { DEFAULT_SESSION_DELTA_PROFILE_SETTINGS } from "./sessionDeltaProfileSettings";

function attach(primitive: SessionDeltaProfilePrimitive) {
  primitive.attached({
    chart: {
      timeScale: () => ({
        timeToCoordinate: (time: number) => time,
        width: () => 1000,
      }),
    },
    series: {
      priceToCoordinate: (price: number) => price * 10,
    },
    requestUpdate: vi.fn(),
  } as never);
}

describe("SessionDeltaProfilePrimitive", () => {
  it("starts each profile at the session start and splits buy and sell bars", () => {
    const primitive = new SessionDeltaProfilePrimitive();
    attach(primitive);

    primitive.setProfile({
      sessionStartTs: 0,
      sessionEndTs: 60_000,
      lastBarTs: 60_000,
      periodMs: 60_000,
      rowWidth: 2,
      rows: [
        { price: 100, buyVolume: 80, sellVolume: 20, totalVolume: 100, knownVolume: 100 },
        { price: 102, buyVolume: 10, sellVolume: 70, totalVolume: 80, knownVolume: 80 },
      ],
      pocPrice: 100,
      buyPocPrice: 100,
      sellPocPrice: 102,
      vahPrice: 100,
      valPrice: 100,
      sessionHigh: 104,
      sessionLow: 98,
    });
    primitive.updateAllViews();

    const buyBars = primitive.renderBars.filter((bar) => bar.x1 >= 0);
    const sellBars = primitive.renderBars.filter((bar) => bar.x2 <= 500);

    expect(buyBars.length).toBeGreaterThan(0);
    expect(sellBars.length).toBeGreaterThan(0);
    expect(Math.max(...buyBars.map((bar) => bar.x1))).toBe(0);
    expect(Math.min(...sellBars.map((bar) => bar.x2))).toBe(0);
    expect(primitive.renderLines.length).toBeGreaterThan(0);
    expect(primitive.renderLabels.map((label) => label.text)).toEqual(
      expect.arrayContaining(["BUY POC: 80.00", "SELL POC: 70.00"]),
    );
  });

  it("uses the default settings for a valid session render", () => {
    const primitive = new SessionDeltaProfilePrimitive();
    attach(primitive);

    primitive.setProfile({
      sessionStartTs: 0,
      sessionEndTs: 60_000,
      lastBarTs: 60_000,
      periodMs: 60_000,
      rowWidth: 2,
      rows: [{ price: 100, buyVolume: 50, sellVolume: 50, totalVolume: 100, knownVolume: 100 }],
      pocPrice: 100,
      buyPocPrice: 100,
      sellPocPrice: 100,
      vahPrice: 100,
      valPrice: 100,
      sessionHigh: 104,
      sessionLow: 98,
    });
    primitive.updateAllViews();

    expect(
      DEFAULT_SESSION_DELTA_PROFILE_SETTINGS.maxBarWidthPx,
    ).toBeGreaterThan(0);
    expect(primitive.renderBars.length).toBeGreaterThan(0);
  });

  it("uses the configured colors with volume-scaled opacity", () => {
    const primitive = new SessionDeltaProfilePrimitive();
    attach(primitive);

    primitive.setProfile({
      sessionStartTs: 0,
      sessionEndTs: 60_000,
      lastBarTs: 60_000,
      periodMs: 60_000,
      rowWidth: 2,
      rows: [
        { price: 100, buyVolume: 20, sellVolume: 0, totalVolume: 20, knownVolume: 20 },
        { price: 102, buyVolume: 100, sellVolume: 0, totalVolume: 100, knownVolume: 100 },
      ],
      pocPrice: 102,
      buyPocPrice: 102,
      sellPocPrice: NaN,
      vahPrice: 102,
      valPrice: 100,
      sessionHigh: 104,
      sessionLow: 98,
    });
    primitive.updateAllViews();

    const fills = primitive.renderBars.map((bar) => bar.fill);
    expect(new Set(fills).size).toBe(2);
    expect(fills[0]).not.toBe(fills[1]);
    expect(fills[0]).toContain("rgba(21, 189, 201,");
    expect(fills[1]).toContain("rgba(21, 189, 201,");
    expect(fills[0]).not.toBe(fills[1]);
  });

  it("returns no bars for an empty session", () => {
    const primitive = new SessionDeltaProfilePrimitive();
    attach(primitive);

    primitive.setProfile({
      sessionStartTs: 0,
      sessionEndTs: 60_000,
      lastBarTs: NaN,
      periodMs: 60_000,
      rowWidth: 2,
      rows: [],
      pocPrice: NaN,
      buyPocPrice: NaN,
      sellPocPrice: NaN,
      vahPrice: NaN,
      valPrice: NaN,
      sessionHigh: 104,
      sessionLow: 98,
    });
    primitive.updateAllViews();

    expect(primitive.renderBars).toEqual([]);
  });
});
