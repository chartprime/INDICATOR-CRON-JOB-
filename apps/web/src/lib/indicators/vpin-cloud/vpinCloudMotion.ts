import type { VpinDirection, VpinReading } from "../../../types/frames";

export type VpinMotionState = {
  direction: Exclude<VpinDirection, null>;
  bloomPhase: number;
  decayPhase: number;
  accelerationBoost: number;
};

export const DEFAULT_BLOOM_DURATION_MS = 500;
export const DEFAULT_DECAY_DURATION_MS = 800;
export const DEFAULT_EDGE_ACCEL_SCALE = 2;

export interface VpinMotionOptions {
  bloomDurationMs?: number;
  decayDurationMs?: number;
  edgeAccelScale?: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function computeVpinMotionState(
  readings: readonly VpinReading[],
  nowMs: number,
  {
    bloomDurationMs = DEFAULT_BLOOM_DURATION_MS,
    decayDurationMs = DEFAULT_DECAY_DURATION_MS,
    edgeAccelScale = DEFAULT_EDGE_ACCEL_SCALE,
  }: VpinMotionOptions = {},
): VpinMotionState | null {
  if (readings.length === 0) return null;
  const last = readings[readings.length - 1];

  if (last.active && last.direction !== null) {
    const bloomElapsed = last.activated_at_ts === null ? Number.POSITIVE_INFINITY : nowMs - last.activated_at_ts;
    const bloomPhase = clamp01(1 - bloomElapsed / bloomDurationMs);
    const accelerationBoost = clamp01(Math.abs(last.z_acceleration ?? 0) / edgeAccelScale);
    return { direction: last.direction, bloomPhase, decayPhase: 0, accelerationBoost };
  }

  let inactiveTailIndex = readings.length - 1;
  while (inactiveTailIndex >= 0 && !readings[inactiveTailIndex].active) {
    const stillWithinDecayWindow = nowMs - readings[inactiveTailIndex].seal_ts < decayDurationMs;
    if (!stillWithinDecayWindow) return null;
    inactiveTailIndex -= 1;
  }
  if (inactiveTailIndex < 0) return null;
  const lastActiveReading = readings[inactiveTailIndex];
  if (lastActiveReading.direction === null) return null;

  const deactivatedAtTs = readings[inactiveTailIndex + 1].seal_ts;
  const decayElapsed = nowMs - deactivatedAtTs;
  const decayPhase = clamp01(1 - decayElapsed / decayDurationMs);
  if (decayPhase <= 0) return null;

  return { direction: lastActiveReading.direction, bloomPhase: 0, decayPhase, accelerationBoost: 0 };
}

export function scaleFillAlpha(fill: string, multiplier: number): string {
  const match = /^rgba\(([^,]+),([^,]+),([^,]+),([^)]+)\)$/.exec(fill);
  if (!match) return fill;
  const alpha = clamp01(Number(match[4]) * multiplier);
  return `rgba(${match[1]},${match[2]},${match[3]},${alpha})`;
}
