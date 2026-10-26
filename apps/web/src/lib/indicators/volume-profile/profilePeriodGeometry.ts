import type { ITimeScaleApi, Logical, Time } from "lightweight-charts";
import type { ProfileFrame } from "../../../types/frames";

export const MIN_ZONE_BAR_WIDTH_PX = 6;
export const POC_LINE_WIDTH_PX = 1.6;
export const VAH_VAL_LINE_WIDTH_PX = 1;
export const MIN_BAR_HEIGHT_PX = 1;

export interface ProfilePeriodGeometry {
  x1: number;
  lineRightEdge: number;
  isDeveloping: boolean;
  opacityMult: number;
  onTop: boolean;
  barWidthBudgetPx: number;
}


export type ProfileAnchorFloor = "pane-edge" | "bar-budget";

export interface BandEdges {
  yTop: number;
  yBottom: number;
}


export function resolveBandEdges(
  priceToCoordinate: (price: number) => number | null,
  price: number,
  rowWidth: number,
): BandEdges | null {
  const upper = priceToCoordinate(price + rowWidth);
  const lower = priceToCoordinate(price);
  if (upper === null || lower === null) return null;
  return {
    yTop: Math.min(upper, lower),
    yBottom: Math.max(upper, lower),
  };
}

export function timeToCoordinateNearest(
  timeScale: ITimeScaleApi<Time>,
  timeSeconds: number,
): number | null {
  const index = timeScale.timeToIndex(timeSeconds as Time, true);
  if (index === null) return null;
  return timeScale.logicalToCoordinate(index as unknown as Logical);
}

/**
 * Where a period's profile sits on the current time axis.
 *
 * A developing period is drawn against the pane's own edges: its right edge
 * is the chart's right edge, and its anchor never leaves the chart's left
 * edge. Closed and historical periods sit at their own timestamps, so they
 * scroll away with the session they describe.
 */
export function resolveProfilePeriodGeometry(
  profile: ProfileFrame,
  timeScale: ITimeScaleApi<Time>,
  isLive: boolean,
  maxBarWidthPx: number,
  developingOpacity: number,
  anchorFloor: ProfileAnchorFloor = "pane-edge",
): ProfilePeriodGeometry | null {
  if (profile.buckets.length === 0) return null;

  const isDeveloping = isLive && profile.period_end_ts === null;
  const opacityMult = isDeveloping ? developingOpacity : 1;

  const anchorX = timeToCoordinateNearest(
    timeScale,
    profile.period_start_ts / 1000,
  );
  if (anchorX === null) return null;

  const x2Closed =
    profile.period_end_ts !== null
      ? timeToCoordinateNearest(timeScale, profile.period_end_ts / 1000)
      : null;
  if (!isLive && x2Closed === null) return null;
  const lineRightEdge = x2Closed ?? timeScale.width();

  const zoneWidthPx =
    x2Closed !== null
      ? Math.max(0, x2Closed - anchorX)
      : Number.POSITIVE_INFINITY;
  const barWidthBudgetPx = Math.max(
    MIN_ZONE_BAR_WIDTH_PX,
    Math.min(maxBarWidthPx, zoneWidthPx),
  );

  // Zooming or panning the session start off screen would otherwise paint the
  // whole developing profile at a negative x, where it simply vanishes. The
  // clamp keeps it readable against the left edge; `max` (rather than a sticky
  // offset) means zooming back out re-anchors it at its true position.
  const floorPx = anchorFloor === "bar-budget" ? barWidthBudgetPx : 0;
  const x1 = isDeveloping ? Math.max(floorPx, anchorX) : anchorX;

  return {
    x1,
    lineRightEdge,
    isDeveloping,
    opacityMult,
    onTop: profile.mode === "per_candle",
    barWidthBudgetPx,
  };
}

export function withOpacity(color: string, opacityMult: number): string {
  const rgbaMatch = /^rgba\(([^,]+),([^,]+),([^,]+),([^)]+)\)$/.exec(
    color.replace(/\s/g, ""),
  );
  if (rgbaMatch) {
    const alpha = Number(rgbaMatch[4]) * opacityMult;
    return `rgba(${rgbaMatch[1]},${rgbaMatch[2]},${rgbaMatch[3]},${alpha})`;
  }
  const hexMatch = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(color);
  if (hexMatch) {
    const r = parseInt(hexMatch[1].slice(0, 2), 16);
    const g = parseInt(hexMatch[1].slice(2, 4), 16);
    const b = parseInt(hexMatch[1].slice(4, 6), 16);
    // An 8-digit hex carries its own alpha, which the multiplier scales -- a
    // semi-transparent tint still fades with the bin gradient rather than
    // sitting at a fixed opacity.
    const alpha =
      hexMatch[2] !== undefined
        ? (parseInt(hexMatch[2], 16) / 255) * opacityMult
        : opacityMult;
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return color;
}
