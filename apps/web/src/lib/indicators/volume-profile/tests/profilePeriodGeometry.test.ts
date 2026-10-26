import { describe, expect, it } from "vitest";
import {
  MIN_ZONE_BAR_WIDTH_PX,
  resolveProfilePeriodGeometry,
  timeToCoordinateNearest,
  withOpacity,
} from "../profilePeriodGeometry";
import type { ProfileFrame } from "../../../../types/frames";

function fakeTimeScale({ hasPoints = true, widthPx = 800, originPx = 0 } = {}) {
  return {
    timeToCoordinate: (time: number) =>
      hasPoints && Number.isInteger(time) ? time * 10 + originPx : null,
    timeToIndex: (time: number, findNearest?: boolean) => {
      if (!hasPoints) return null;
      if (Number.isInteger(time)) return time;
      return findNearest ? Math.round(time) : null;
    },
    logicalToCoordinate: (index: number) => index * 10 + originPx,
    width: () => widthPx,
  };
}

const PROFILE: ProfileFrame = {
  type: "profile",
  provider: "BINANCE",
  symbol: "BTC-USDT",
  marketKind: "SPOT",
  mode: "continuous",
  period_start_ts: 1000,
  period_end_ts: null,
  row_width: 2,
  delivery_scope: "LIVE",
  history_request_id: null,
  buckets: [
    {
      price: 100,
      volume: 5,
      buy_volume: 3,
      sell_volume: 2,
      single_print: false,
    },
  ],
  poc_price: 100,
  vah_price: 100,
  val_price: 100,
};

describe("timeToCoordinateNearest", () => {
  it("resolves an exact integer-seconds bar directly", () => {
    expect(timeToCoordinateNearest(fakeTimeScale() as never, 1)).toBe(10);
  });

  it("snaps an off-grid timestamp to the nearest real bar instead of failing", () => {
    expect(timeToCoordinateNearest(fakeTimeScale() as never, 1.3)).toBe(10);
  });

  it("returns null when the chart has no bar points to resolve against", () => {
    expect(
      timeToCoordinateNearest(fakeTimeScale({ hasPoints: false }) as never, 1),
    ).toBeNull();
  });
});

describe("resolveProfilePeriodGeometry", () => {
  it("returns null for a profile with no buckets -- nothing to place", () => {
    const geometry = resolveProfilePeriodGeometry(
      { ...PROFILE, buckets: [] },
      fakeTimeScale() as never,
      true,
      110,
      0.6,
    );
    expect(geometry).toBeNull();
  });

  it("returns null when the chart cannot resolve any coordinate", () => {
    const geometry = resolveProfilePeriodGeometry(
      PROFILE,
      fakeTimeScale({ hasPoints: false }) as never,
      true,
      110,
      0.6,
    );
    expect(geometry).toBeNull();
  });

  it("a live developing period extends to the chart's full width and reports isDeveloping", () => {
    const geometry = resolveProfilePeriodGeometry(
      PROFILE,
      fakeTimeScale({ widthPx: 800 }) as never,
      true,
      110,
      0.6,
    );
    expect(geometry).not.toBeNull();
    expect(geometry?.x1).toBe(10);
    expect(geometry?.lineRightEdge).toBe(800);
    expect(geometry?.isDeveloping).toBe(true);
    expect(geometry?.opacityMult).toBe(0.6);
  });

  it("a closed period's right edge is its own period_end_ts, not the chart's width", () => {
    const geometry = resolveProfilePeriodGeometry(
      { ...PROFILE, period_end_ts: 3000 },
      fakeTimeScale() as never,
      true,
      110,
      0.6,
    );
    expect(geometry?.lineRightEdge).toBe(30);
    expect(geometry?.isDeveloping).toBe(false);
    expect(geometry?.opacityMult).toBe(1);
  });

  it("a non-live (historical) zone with no resolvable end returns null -- it must never fall back to full width", () => {
    const geometry = resolveProfilePeriodGeometry(
      PROFILE,
      fakeTimeScale() as never,
      false,
      110,
      0.6,
    );
    expect(geometry).toBeNull();
  });

  it("tags onTop true only for per_candle mode", () => {
    expect(
      resolveProfilePeriodGeometry(
        { ...PROFILE, mode: "per_candle" },
        fakeTimeScale() as never,
        true,
        110,
        0.6,
      )?.onTop,
    ).toBe(true);
    expect(
      resolveProfilePeriodGeometry(
        { ...PROFILE, mode: "continuous" },
        fakeTimeScale() as never,
        true,
        110,
        0.6,
      )?.onTop,
    ).toBe(false);
    expect(
      resolveProfilePeriodGeometry(
        { ...PROFILE, mode: "fixed_range", period_end_ts: 3000 },
        fakeTimeScale() as never,
        true,
        110,
        0.6,
      )?.onTop,
    ).toBe(false);
  });

  it("caps the bar-width budget to the zone's own on-screen width when narrower than the setting", () => {
    // period_start_ts 1000 -> x1=10, period_end_ts 1100 -> x2=Math.round(1.1)*10=10 (rounds to same bar) --
    // use a genuinely narrow but distinct zone instead: 1000 -> 2000 gives a 10px zone.
    const geometry = resolveProfilePeriodGeometry(
      { ...PROFILE, period_end_ts: 2000 },
      fakeTimeScale() as never,
      true,
      110,
      0.6,
    );
    expect(geometry?.barWidthBudgetPx).toBeLessThanOrEqual(10);
  });

  it("never shrinks the bar-width budget below the minimum floor, even for a near-zero-width zone", () => {
    const geometry = resolveProfilePeriodGeometry(
      { ...PROFILE, period_start_ts: 1000, period_end_ts: 1000 + 1 },
      fakeTimeScale() as never,
      true,
      110,
      0.6,
    );
    // period_end_ts 1001ms -> 1.001s rounds to the same bar as x1, giving a 0px zone --
    // the floor must still apply.
    expect(geometry?.barWidthBudgetPx).toBeGreaterThanOrEqual(
      MIN_ZONE_BAR_WIDTH_PX,
    );
  });

  it("uses the full setting as the budget when the zone is wider than the cap", () => {
    const geometry = resolveProfilePeriodGeometry(
      { ...PROFILE, period_start_ts: 1000, period_end_ts: 21000 },
      fakeTimeScale() as never,
      true,
      110,
      0.6,
    );
    expect(geometry?.barWidthBudgetPx).toBe(110);
  });

  it("sticks a developing period's anchor to the chart's left edge once the session start is off screen", () => {
    // originPx -50 puts the period's start bar (index 1) at x = -40. Without
    // the clamp every bin is painted at a negative x and the whole profile
    // disappears as soon as zooming pushes the session start past the edge.
    const geometry = resolveProfilePeriodGeometry(
      PROFILE,
      fakeTimeScale({ originPx: -50 }) as never,
      true,
      110,
      0.6,
    );
    expect(geometry?.x1).toBe(0);
    expect(geometry?.isDeveloping).toBe(true);
    // Only the anchor moves: the budget is still the setting, so every bin
    // keeps its own width.
    expect(geometry?.barWidthBudgetPx).toBe(110);
  });

  it("leaves a closed or historical period at its true off-screen position", () => {
    const closed = resolveProfilePeriodGeometry(
      { ...PROFILE, period_end_ts: 3000 },
      fakeTimeScale({ originPx: -50 }) as never,
      true,
      110,
      0.6,
    );
    expect(closed?.x1).toBe(-40);
    expect(closed?.isDeveloping).toBe(false);

    const historical = resolveProfilePeriodGeometry(
      { ...PROFILE, period_end_ts: 3000 },
      fakeTimeScale({ originPx: -50 }) as never,
      false,
      110,
      0.6,
    );
    expect(historical?.x1).toBe(-40);
  });

  it("floors a developing anchor at the bar budget when asked, so bars drawn left of it stay on screen", () => {
    const offScreen = resolveProfilePeriodGeometry(
      PROFILE,
      fakeTimeScale({ originPx: -50 }) as never,
      true,
      110,
      0.6,
      "bar-budget",
    );
    expect(offScreen?.x1).toBe(110);
    expect(offScreen?.barWidthBudgetPx).toBe(110);

    const insideTheBudget = resolveProfilePeriodGeometry(
      PROFILE,
      fakeTimeScale({ originPx: 30 }) as never,
      true,
      110,
      0.6,
      "bar-budget",
    );
    expect(insideTheBudget?.x1).toBe(110);

    const beyondTheBudget = resolveProfilePeriodGeometry(
      PROFILE,
      fakeTimeScale({ originPx: 200 }) as never,
      true,
      110,
      0.6,
      "bar-budget",
    );
    expect(beyondTheBudget?.x1).toBe(210);
  });

  it("never floors a closed period, whichever floor is asked for", () => {
    const closed = resolveProfilePeriodGeometry(
      { ...PROFILE, period_end_ts: 3000 },
      fakeTimeScale({ originPx: -50 }) as never,
      true,
      110,
      0.6,
      "bar-budget",
    );
    expect(closed?.x1).toBe(-40);
    // The zone spans -40 to -20, so its budget is its own 20px width.
    expect(closed?.barWidthBudgetPx).toBe(20);
  });
});

describe("withOpacity", () => {
  it("scales an rgba color's own alpha by the multiplier", () => {
    expect(withOpacity("rgba(10, 20, 30, 0.5)", 0.5)).toBe(
      "rgba(10,20,30,0.25)",
    );
  });

  it("converts a hex color to rgba at the multiplier as the alpha", () => {
    expect(withOpacity("#c23854", 0.5)).toBe("rgba(194,56,84,0.5)");
  });

  // An 8-digit hex carries its own alpha. Scaling it (rather than discarding it
  // and using the multiplier alone) is what lets a semi-transparent tint still
  // fade with the bin gradient instead of sitting at a fixed opacity.
  it("scales an 8-digit hex color's own alpha by the multiplier", () => {
    const alphaOf = (fill: string) =>
      Number(/rgba\([^)]*,\s*([0-9.]+)\)$/.exec(fill)![1]);

    expect(withOpacity("#c23854ff", 1)).toBe("rgba(194,56,84,1)");
    expect(withOpacity("#c2385400", 1)).toBe("rgba(194,56,84,0)");

    const halfAlpha = withOpacity("#c238547f", 1);
    expect(halfAlpha.startsWith("rgba(194,56,84,")).toBe(true);
    expect(alphaOf(halfAlpha)).toBeCloseTo(0x7f / 255, 10);
    expect(alphaOf(withOpacity("#c238547f", 0.5))).toBeCloseTo(
      (0x7f / 255) * 0.5,
      10,
    );
  });

  it("passes through anything it does not recognize unchanged", () => {
    expect(withOpacity("currentColor", 0.5)).toBe("currentColor");
  });
});
