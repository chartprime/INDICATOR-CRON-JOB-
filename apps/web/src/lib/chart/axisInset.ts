export const AXIS_INSET_GAP_PX = 8;

export interface AxisOccupant {
  widthPx(paneWidth: number): number;
  resize?(widthPx: number, paneWidth: number): void;
}

export function axisInsetPx(occupants: readonly AxisOccupant[], paneWidth: number): number {
  let widest = 0;
  for (const occupant of occupants) widest = Math.max(widest, occupant.widthPx(paneWidth));
  return widest > 0 ? widest + AXIS_INSET_GAP_PX : 0;
}
