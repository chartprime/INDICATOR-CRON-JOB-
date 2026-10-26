import { describe, expect, it } from "vitest";
import { computeVpinMotionState, scaleFillAlpha } from "../vpinCloudMotion";
import type { VpinReading } from "../../../../types/frames";

function reading(sealTs: number, overrides: Partial<VpinReading> = {}): VpinReading {
  return {
    seal_ts: sealTs, active: true, direction: "buy", strength: 0.5,
    z_vpin: 1, z_velocity: 0.1, z_acceleration: 0.5, activated_at_ts: sealTs,
    ...overrides,
  };
}

describe("computeVpinMotionState", () => {
  it("returns null for an empty reading history", () => {
    expect(computeVpinMotionState([], 1_000)).toBeNull();
  });

  it("bloomPhase is 1 right at activation, and decays to 0 by bloomDurationMs later", () => {
    const readings = [reading(1_000, { activated_at_ts: 1_000 })];
    expect(computeVpinMotionState(readings, 1_000, { bloomDurationMs: 500 })?.bloomPhase).toBe(1);
    expect(computeVpinMotionState(readings, 1_250, { bloomDurationMs: 500 })?.bloomPhase).toBe(0.5);
    expect(computeVpinMotionState(readings, 1_500, { bloomDurationMs: 500 })?.bloomPhase).toBe(0);
    expect(computeVpinMotionState(readings, 2_000, { bloomDurationMs: 500 })?.bloomPhase).toBe(0);
  });

  it("carries the active reading's direction while active", () => {
    const readings = [reading(1_000, { direction: "sell" })];
    expect(computeVpinMotionState(readings, 1_000)?.direction).toBe("sell");
  });

  it("derives accelerationBoost from |z_acceleration| scaled and clamped to [0,1]", () => {
    const readings = [reading(1_000, { z_acceleration: 1 })];
    expect(computeVpinMotionState(readings, 1_000, { edgeAccelScale: 2 })?.accelerationBoost).toBe(0.5);

    const strong = [reading(1_000, { z_acceleration: -10 })];
    expect(computeVpinMotionState(strong, 1_000, { edgeAccelScale: 2 })?.accelerationBoost).toBe(1);
  });

  it("treats a null z_acceleration as zero boost, not a crash", () => {
    const readings = [reading(1_000, { z_acceleration: null })];
    expect(computeVpinMotionState(readings, 1_000)?.accelerationBoost).toBe(0);
  });

  it("treats a null activated_at_ts on an active reading as fully settled, not a fresh bloom", () => {
    const readings = [reading(1_000, { activated_at_ts: null })];
    expect(computeVpinMotionState(readings, 1_000)?.bloomPhase).toBe(0);
  });

  it("decays for decayDurationMs after the transition into inactive, carrying the last active direction", () => {
    const readings = [
      reading(1_000, { direction: "sell" }),
      reading(1_100, { active: false, direction: null, strength: 0, activated_at_ts: null }),
    ];
    const atTransition = computeVpinMotionState(readings, 1_100, { decayDurationMs: 800 });
    expect(atTransition).toEqual({ direction: "sell", bloomPhase: 0, decayPhase: 1, accelerationBoost: 0 });

    const midDecay = computeVpinMotionState(readings, 1_500, { decayDurationMs: 800 });
    expect(midDecay?.decayPhase).toBe(0.5);
    expect(midDecay?.direction).toBe("sell");

    expect(computeVpinMotionState(readings, 1_900, { decayDurationMs: 800 })).toBeNull();
  });

  it("keeps decaying smoothly when a burst seals further inactive buckets during the decay window -- doesn't snap off at the second one", () => {
    const readings = [
      reading(1_000, { direction: "sell" }),
      reading(1_005, { active: false, direction: null, strength: 0, activated_at_ts: null }),
    ];
    const beforeBurst = computeVpinMotionState(readings, 1_045, { decayDurationMs: 800 });
    expect(beforeBurst?.decayPhase).toBeGreaterThan(0);
    expect(beforeBurst?.direction).toBe("sell");

    readings.push({ ...readings[1], seal_ts: 1_010 });
    const atSameWallClockMoment = computeVpinMotionState(readings, 1_045, { decayDurationMs: 800 });
    expect(atSameWallClockMoment).toEqual(beforeBurst);
  });

  it("returns null once the decay window has fully elapsed", () => {
    const readings = [
      reading(1_000),
      reading(1_100, { active: false, direction: null, strength: 0, activated_at_ts: null }),
    ];
    expect(computeVpinMotionState(readings, 5_000, { decayDurationMs: 800 })).toBeNull();
  });

  it("returns null when the reading before the current inactive one was also inactive -- not a fresh transition", () => {
    const readings = [
      reading(1_000, { active: false, direction: null, strength: 0, activated_at_ts: null }),
      reading(1_100, { active: false, direction: null, strength: 0, activated_at_ts: null }),
    ];
    expect(computeVpinMotionState(readings, 1_150)).toBeNull();
  });

  it("returns null for a lone inactive reading with no history to decay from", () => {
    const readings = [reading(1_000, { active: false, direction: null, strength: 0, activated_at_ts: null })];
    expect(computeVpinMotionState(readings, 1_000)).toBeNull();
  });
});

describe("scaleFillAlpha", () => {
  it("scales the alpha channel of an rgba string", () => {
    expect(scaleFillAlpha("rgba(16,220,128,0.5)", 0.5)).toBe("rgba(16,220,128,0.25)");
  });

  it("clamps the scaled alpha to [0, 1]", () => {
    expect(scaleFillAlpha("rgba(16,220,128,0.8)", 2)).toBe("rgba(16,220,128,1)");
    expect(scaleFillAlpha("rgba(16,220,128,0.5)", -1)).toBe("rgba(16,220,128,0)");
  });

  it("returns a non-rgba string unchanged", () => {
    expect(scaleFillAlpha("#ff0000", 0.5)).toBe("#ff0000");
  });
});
