import { describe, expect, it } from "vitest";
import {
  DEFAULT_VPIN_SENSITIVITY,
  MAX_VPIN_SENSITIVITY,
  MIN_VPIN_SENSITIVITY,
  deriveDefaultVpinSensitivity,
  reapplyVpinHysteresis,
} from "../vpinSensitivity";
import type { VpinReading } from "../../../../types/frames";

function reading(sealTs: number, zVpin: number | null, overrides: Partial<VpinReading> = {}): VpinReading {
  return {
    seal_ts: sealTs, active: false, direction: null, strength: 0,
    z_vpin: zVpin, z_velocity: 0.1, z_acceleration: 0.01, activated_at_ts: null,
    ...overrides,
  };
}

describe("reapplyVpinHysteresis", () => {
  it("rejects a non-positive zOn", () => {
    expect(() => reapplyVpinHysteresis([], 0)).toThrow(/zOn/);
    expect(() => reapplyVpinHysteresis([], -1)).toThrow(/zOn/);
  });

  it("leaves a null-z_vpin reading fully inactive", () => {
    const [out] = reapplyVpinHysteresis([reading(1_000, null)], 1);
    expect(out).toMatchObject({ active: false, direction: null, strength: 0, activated_at_ts: null });
  });

  it("activates once |z_vpin| crosses zOn, carrying the sign as direction", () => {
    const [buy] = reapplyVpinHysteresis([reading(1_000, 1.5)], 1);
    expect(buy.active).toBe(true);
    expect(buy.direction).toBe("buy");
    expect(buy.activated_at_ts).toBe(1_000);

    const [sell] = reapplyVpinHysteresis([reading(1_000, -1.5)], 1);
    expect(sell.direction).toBe("sell");
  });

  it("does not activate while |z_vpin| stays below zOn", () => {
    const [out] = reapplyVpinHysteresis([reading(1_000, 0.9)], 1);
    expect(out.active).toBe(false);
  });

  it("stays active below zOn as long as it stays above zOff and the sign hasn't flipped", () => {
    const readings = [reading(1_000, 1.5), reading(1_100, 0.5)];
    const out = reapplyVpinHysteresis(readings, 1, 0.2);
    expect(out[0].active).toBe(true);
    expect(out[1].active).toBe(true);
    expect(out[1].direction).toBe("buy");
  });

  it("deactivates once |z_vpin| drops below zOff", () => {
    const readings = [reading(1_000, 1.5), reading(1_100, 0.1)];
    const out = reapplyVpinHysteresis(readings, 1, 0.2);
    expect(out[1].active).toBe(false);
    expect(out[1].direction).toBeNull();
  });

  it("keeps activated_at_ts pinned to the original activation, not updated on every continuing reading", () => {
    const readings = [reading(1_000, 1.5), reading(1_100, 1.2), reading(1_200, 0.5)];
    const out = reapplyVpinHysteresis(readings, 1, 0.2);
    expect(out.map((r) => r.activated_at_ts)).toEqual([1_000, 1_000, 1_000]);
  });

  it("treats a sign flip as a fresh transition, not a continuation", () => {
    const readings = [reading(1_000, 1.5), reading(1_100, -1.5)];
    const out = reapplyVpinHysteresis(readings, 1, 0.2);
    expect(out[0].direction).toBe("buy");
    expect(out[1].direction).toBe("sell");
    expect(out[1].activated_at_ts).toBe(1_100);
  });

  it("computes strength from the active z-score scaled by 3x zOn, clamped to 1", () => {
    const [out] = reapplyVpinHysteresis([reading(1_000, 1.5)], 1);
    expect(out.strength).toBeCloseTo(0.5, 10);

    const [saturated] = reapplyVpinHysteresis([reading(1_000, 10)], 1);
    expect(saturated.strength).toBe(1);
  });

  it("leaves seal_ts, z_vpin, z_velocity, and z_acceleration untouched -- only the hysteresis-derived fields change", () => {
    const [out] = reapplyVpinHysteresis([reading(1_000, 1.5, { z_velocity: 0.7, z_acceleration: -0.3 })], 1);
    expect(out.seal_ts).toBe(1_000);
    expect(out.z_vpin).toBe(1.5);
    expect(out.z_velocity).toBe(0.7);
    expect(out.z_acceleration).toBe(-0.3);
  });

  it("re-derives independently of the reading's own server-computed active/direction/strength", () => {
    const readings = [reading(1_000, 0.5, { active: true, direction: "buy", strength: 0.9, activated_at_ts: 900 })];
    const [out] = reapplyVpinHysteresis(readings, 2);
    expect(out.active).toBe(false);
    expect(out.direction).toBeNull();
  });
});

describe("deriveDefaultVpinSensitivity", () => {
  it("falls back to the fixed default when there isn't enough backfilled data", () => {
    expect(deriveDefaultVpinSensitivity([])).toBe(DEFAULT_VPIN_SENSITIVITY);
    const few = Array.from({ length: 5 }, (_, i) => reading(i, 1 + i * 0.1));
    expect(deriveDefaultVpinSensitivity(few)).toBe(DEFAULT_VPIN_SENSITIVITY);
  });

  it("derives the 85th percentile of |z_vpin| once there's enough backfilled data", () => {
    const readings = Array.from({ length: 100 }, (_, i) => reading(i, (i + 1) / 100));
    const result = deriveDefaultVpinSensitivity(readings);
    expect(result).toBeCloseTo(0.86, 1);
  });

  it("ignores readings with a null z_vpin when counting toward the minimum and the percentile", () => {
    const nulls = Array.from({ length: 100 }, (_, i) => reading(i, null));
    expect(deriveDefaultVpinSensitivity(nulls)).toBe(DEFAULT_VPIN_SENSITIVITY);
  });

  it("clamps the derived value to [MIN_VPIN_SENSITIVITY, MAX_VPIN_SENSITIVITY]", () => {
    const tiny = Array.from({ length: 100 }, (_, i) => reading(i, 0.01 + i * 0.0001));
    expect(deriveDefaultVpinSensitivity(tiny)).toBeGreaterThanOrEqual(MIN_VPIN_SENSITIVITY);

    const huge = Array.from({ length: 100 }, (_, i) => reading(i, 50 + i));
    expect(deriveDefaultVpinSensitivity(huge)).toBeLessThanOrEqual(MAX_VPIN_SENSITIVITY);
  });
});
