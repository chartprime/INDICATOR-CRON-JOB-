import type { SwingProfileBar } from "./swingAlphabetProfileBins";

export interface SwingBubbleBar extends SwingProfileBar {
  open: number;
  high: number;
  low: number;
}

export interface SwingVolumeBubble {
  time: number;
  price: number;
  sizePx: number;
  textSizePx: number;
  color: string;
  text: string;
}

/** Keeps a two-digit label inside the circle. */
const BUBBLE_TEXT_SIZE_RATIO = 0.4;

function bubbleSizePx(percent: number): number {
  if (percent >= 90) return 50;
  if (percent >= 75) return 40;
  if (percent >= 50) return 30;
  return 20;
}

function withOpacity(color: string, alpha: number): string {
  if (color.startsWith("#") && color.length === 7) {
    const r = Number.parseInt(color.slice(1, 3), 16);
    const g = Number.parseInt(color.slice(3, 5), 16);
    const b = Number.parseInt(color.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

/** Ports Pine's volume-bubble loop: every leg is scaled against its own peak volume, so bubble sizes are relative to the leg rather than the whole chart. */
export function computeSwingVolumeBubbles(
  legBars: readonly SwingBubbleBar[],
  bullColor: string,
  bearColor: string,
  minPercent: number,
): SwingVolumeBubble[] {
  if (legBars.length === 0) return [];
  let maxVolume = 0;
  for (const legBar of legBars) {
    if (legBar.volume > maxVolume) maxVolume = legBar.volume;
  }
  if (maxVolume <= 0) return [];

  const bubbles: SwingVolumeBubble[] = [];
  for (const legBar of legBars) {
    const percent = (legBar.volume / maxVolume) * 100;
    if (percent < minPercent) continue;
    const alpha = percent / 100;
    const sizePx = bubbleSizePx(percent);
    bubbles.push({
      time: legBar.time,
      price: (legBar.high + legBar.low + legBar.close) / 3,
      sizePx,
      textSizePx: Math.round(sizePx * BUBBLE_TEXT_SIZE_RATIO),
      color: withOpacity(
        legBar.close > legBar.open ? bullColor : bearColor,
        alpha,
      ),
      text: String(Math.trunc(percent / 10)),
    });
  }
  return bubbles;
}
