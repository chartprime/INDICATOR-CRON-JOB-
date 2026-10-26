import { describe, expect, it, vi } from "vitest";
import { nearestSeriesTime, snappedTimeToCoordinate } from "../trendlineGeometry";

const MIN = 60;
const BASE = 1_700_000_000;

// A 15-minute series: only these times exist on the chart's time scale.
const FIFTEEN_MIN_SERIES = Array.from({ length: 8 }, (_, i) => BASE + i * 15 * MIN);

describe("nearestSeriesTime", () => {
  it("returns an exact match unchanged", () => {
    expect(nearestSeriesTime(BASE + 30 * MIN, FIFTEEN_MIN_SERIES)).toBe(BASE + 30 * MIN);
  });

  it("snaps a 1-minute anchor to the nearest bar that actually exists on a 15-minute series", () => {
    // 10:07 is closer to 10:00 than to 10:15.
    expect(nearestSeriesTime(BASE + 7 * MIN, FIFTEEN_MIN_SERIES)).toBe(BASE);
    // 10:08 is closer to 10:15.
    expect(nearestSeriesTime(BASE + 8 * MIN, FIFTEEN_MIN_SERIES)).toBe(BASE + 15 * MIN);
  });

  it("breaks an exact midpoint tie toward the earlier bar, deterministically", () => {
    const midpoint = BASE + 7.5 * MIN;
    expect(nearestSeriesTime(midpoint, FIFTEEN_MIN_SERIES)).toBe(BASE);
  });

  it("returns null outside the loaded range rather than clamping a drawing onto the edge", () => {
    expect(nearestSeriesTime(BASE - 1, FIFTEEN_MIN_SERIES)).toBeNull();
    expect(nearestSeriesTime(BASE + 8 * 15 * MIN, FIFTEEN_MIN_SERIES)).toBeNull();
  });

  it("returns null for an empty series instead of throwing", () => {
    expect(nearestSeriesTime(BASE, [])).toBeNull();
  });

  it("handles a single-bar series", () => {
    expect(nearestSeriesTime(BASE, [BASE])).toBe(BASE);
    expect(nearestSeriesTime(BASE + 1, [BASE])).toBeNull();
  });
});

describe("snappedTimeToCoordinate", () => {
  it("keeps a drawing visible after a timeframe switch -- the bug this exists for", () => {
    // Real lightweight-charts v5 behaviour, measured: timeToCoordinate returns
    // null for any time not present on the time scale, so a 1m-anchored
    // drawing silently disappeared when the chart moved to 15m.
    const raw = vi.fn((t: number) => (FIFTEEN_MIN_SERIES.includes(t) ? t - BASE : null));

    expect(raw(BASE + 7 * MIN)).toBeNull();
    expect(snappedTimeToCoordinate(raw, FIFTEEN_MIN_SERIES)(BASE + 7 * MIN)).toBe(0);
  });

  it("does not disturb a time the scale already resolves", () => {
    const raw = vi.fn(() => 123);
    expect(snappedTimeToCoordinate(raw, FIFTEEN_MIN_SERIES)(BASE + 7 * MIN)).toBe(123);
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it("still yields null when the anchor lies outside the loaded range", () => {
    const raw = vi.fn(() => null);
    expect(snappedTimeToCoordinate(raw, FIFTEEN_MIN_SERIES)(BASE - 10 * MIN)).toBeNull();
  });
});
