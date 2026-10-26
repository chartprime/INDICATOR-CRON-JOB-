/**
 * The status badges indicators draw in the chart's top-left corner. Each producer owns a row of its own, so any number
 * of them can show at once without overlapping: S/R's source, Book Map's source and cell cap, Absorption, and Volume Profile
 * (Ticks) drawing a candle estimate.
 */
export const STATUS_BADGE_SLOT = Object.freeze({
  supportResistance: 0,
  bookMapSource: 1,
  bookMapCellCap: 2,
  absorption: 3,
  volumeProfileTickEstimate: 4,
  whaleHeatmap: 5,
  heatmap: 6,
  iceberg: 7,
  exhaustion: 8,
  initiative: 9,
});

export type StatusBadgeSlot = (typeof STATUS_BADGE_SLOT)[keyof typeof STATUS_BADGE_SLOT];

const LEFT = 8;
const TOP = 8;
const ROW = 26;
const HEIGHT = 22;
const PADDING = 6;
// 11px monospace: every character has the same advance, so the box is sized without measuring.
const CHAR_WIDTH = 6.7;

export interface StatusBadgeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function statusBadgeBox(slot: StatusBadgeSlot, text: string): StatusBadgeBox {
  return { x: LEFT, y: TOP + slot * ROW, width: Math.ceil(text.length * CHAR_WIDTH) + 2 * PADDING, height: HEIGHT };
}

type BadgeContext = Pick<CanvasRenderingContext2D, "fillRect" | "fillText"> & Partial<Pick<CanvasRenderingContext2D, "save" | "restore">> & {
  fillStyle: unknown;
  font?: string;
  textAlign?: CanvasTextAlign;
  textBaseline?: CanvasTextBaseline;
};

export function drawStatusBadge(context: BadgeContext, slot: StatusBadgeSlot, text: string): void {
  const box = statusBadgeBox(slot, text);
  context.save?.();
  context.fillStyle = "rgba(20, 20, 30, 0.86)";
  context.fillRect(box.x, box.y, box.width, box.height);
  context.fillStyle = "rgba(255, 255, 255, 0.95)";
  context.font = "11px monospace";
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  context.fillText(text, box.x + PADDING, box.y + 15);
  context.restore?.();
}
