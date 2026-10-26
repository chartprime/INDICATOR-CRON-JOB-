import type { ProfileMode } from "../../../types/frames";

/**
 * The session/binning configuration every profile view shares: the merged
 * Session Volume Profile indicator exposes it once, and the volume, net-delta
 * and delta rendering primitives all read the profile frames it requests.
 */

export const DEFAULT_VOLUME_PROFILE_PERIOD_MS = 4 * 60 * 60 * 1000;

export const MIN_BIN_SIZE_MULTIPLIER = 0.02;
export const MAX_BIN_SIZE_MULTIPLIER = 10;
export const DEFAULT_BIN_SIZE_MULTIPLIER = 2;

export function isBinSizeMultiplier(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_BIN_SIZE_MULTIPLIER &&
    value <= MAX_BIN_SIZE_MULTIPLIER
  );
}

export const PROFILE_PERIOD_PRESETS: readonly { label: string; ms: number }[] =
  [
    { label: "5 Minutes", ms: 5 * 60 * 1000 },
    { label: "15 Minutes", ms: 15 * 60 * 1000 },
    { label: "30 Minutes", ms: 30 * 60 * 1000 },
    { label: "1 Hour", ms: 60 * 60 * 1000 },
    { label: "4 Hours", ms: 4 * 60 * 60 * 1000 },
    { label: "12 Hours", ms: 12 * 60 * 60 * 1000 },
    { label: "1 Day", ms: 24 * 60 * 60 * 1000 },
    { label: "2 Days", ms: 2 * 24 * 60 * 60 * 1000 },
    { label: "3 Days", ms: 3 * 24 * 60 * 60 * 1000 },
    { label: "1 Week", ms: 7 * 24 * 60 * 60 * 1000 },
  ];

/** Only "continuous"/"per_candle" are user-selectable; "fixed_range" is a
 * separate, drawing-tool-driven request shape (see ChartPanel/MainPanel's
 * fixedRangeProfile handling), never a settings-schema value. */
export type ProfileSessionMode = Extract<
  ProfileMode,
  "continuous" | "per_candle"
>;

export const DEFAULT_PROFILE_SESSION_MODE: ProfileSessionMode = "continuous";
