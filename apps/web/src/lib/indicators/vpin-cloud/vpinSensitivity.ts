import type { VpinReading } from "../../../types/frames";

export const DEFAULT_VPIN_SENSITIVITY = 1.0;
export const MIN_VPIN_SENSITIVITY = 0.3;
export const MAX_VPIN_SENSITIVITY = 4;
const DEFAULT_ZOFF_RATIO = 0.2;
const DEFAULT_SENSITIVITY_PERCENTILE = 0.85;
export const MIN_READINGS_FOR_DERIVED_DEFAULT = 20;

function sign(value: number): number {
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

function clampSensitivity(value: number): number {
  return Math.min(MAX_VPIN_SENSITIVITY, Math.max(MIN_VPIN_SENSITIVITY, value));
}

export function reapplyVpinHysteresis(
  readings: readonly VpinReading[],
  zOn: number,
  zOffRatio: number = DEFAULT_ZOFF_RATIO,
): VpinReading[] {
  if (!Number.isFinite(zOn) || zOn <= 0) {
    throw new Error("reapplyVpinHysteresis: zOn must be a positive finite number");
  }
  const zOff = zOn * zOffRatio;
  let active = false;
  let direction = 0;
  let zActive = 0;
  let activatedAtTs: number | null = null;

  return readings.map((reading) => {
    const z = reading.z_vpin;
    if (z === null || !Number.isFinite(z)) {
      active = false;
      direction = 0;
      zActive = 0;
      activatedAtTs = null;
      return { ...reading, active: false, direction: null, strength: 0, activated_at_ts: null };
    }

    const wasActive = active;
    const wasDirection = direction;
    if (active && sign(z) === direction && Math.abs(z) >= zOff) {
      zActive = z;
    } else {
      active = false;
      direction = 0;
      if (Math.abs(z) >= zOn) {
        active = true;
        direction = sign(z);
      }
      zActive = active ? z : 0;
    }
    if (active && (!wasActive || direction !== wasDirection)) {
      activatedAtTs = reading.seal_ts;
    }
    if (!active) activatedAtTs = null;

    return {
      ...reading,
      active,
      direction: direction > 0 ? "buy" : direction < 0 ? "sell" : null,
      strength: active ? Math.min(1, Math.abs(zActive) / (zOn * 3)) : 0,
      activated_at_ts: activatedAtTs,
    };
  });
}

export function deriveDefaultVpinSensitivity(readings: readonly VpinReading[]): number {
  const magnitudes = readings
    .map((reading) => reading.z_vpin)
    .filter((z): z is number => z !== null && Number.isFinite(z))
    .map((z) => Math.abs(z))
    .sort((a, b) => a - b);
  if (magnitudes.length < MIN_READINGS_FOR_DERIVED_DEFAULT) return DEFAULT_VPIN_SENSITIVITY;
  const index = Math.min(
    magnitudes.length - 1,
    Math.floor(magnitudes.length * DEFAULT_SENSITIVITY_PERCENTILE),
  );
  return clampSensitivity(magnitudes[index]);
}
