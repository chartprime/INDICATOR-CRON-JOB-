export const WHALE_CARD_WIDTH_PX = 262;
export const WHALE_CARD_FLIP_BELOW_PX = 220;

export function clampCardX(x: number, containerWidth: number): number {
  const half = WHALE_CARD_WIDTH_PX / 2 + 6;
  if (!(containerWidth > 2 * half)) return x;
  return Math.min(containerWidth - half, Math.max(half, x));
}
