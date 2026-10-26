export const LABEL_FONT_PX = 11;
export const MIN_LABEL_FONT_PX = 8;

export function labelFontPx(rowPx: number): number {
  return Math.max(MIN_LABEL_FONT_PX, Math.min(LABEL_FONT_PX, Math.floor(rowPx - 2)));
}

export const HANDLE_GRAB_PX = 6;

export interface HandleFrame {
  right: number;
  reach: number;
  height: number;
  width: number;
}

export function onReachHandle(frame: HandleFrame, x: number, y: number, grabPx: number = HANDLE_GRAB_PX): boolean {
  return y >= 0 && y <= frame.height && Math.abs(x - (frame.right - frame.reach)) <= grabPx;
}

export function reachShareAt(frame: HandleFrame, x: number, minShare: number, maxShare: number): number {
  if (!(frame.width > 0)) return minShare;
  return Math.min(maxShare, Math.max(minShare, (frame.right - x) / frame.width));
}

export function onBaseHandle(frame: HandleFrame, x: number, y: number, grabPx: number = HANDLE_GRAB_PX): boolean {
  return y >= 0 && y <= frame.height && Math.abs(x - frame.right) <= grabPx;
}

export function neighbourWidthAt(frame: HandleFrame, x: number, gapPx: number): number {
  if (!(frame.width > 0)) return 0;
  return Math.max(0, frame.width - gapPx - x);
}

export function reachShareForWidth(reachPx: number, widthPx: number, wantedPx: number, paneWidth: number, minShare: number, maxShare: number): number {
  if (!(paneWidth > 0)) return minShare;
  return Math.min(maxShare, Math.max(minShare, (reachPx + wantedPx - widthPx) / paneWidth));
}

export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const value = Number.parseInt(hex[1], 16);
    return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(color.trim());
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
  return color;
}
