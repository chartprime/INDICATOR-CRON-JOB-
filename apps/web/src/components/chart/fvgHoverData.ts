import type { FVGHoverData } from "../../lib/indicators/fvg-delta/fvgDelta";

export function fvgHoverDataFromUnknown(value: unknown): readonly FVGHoverData[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is FVGHoverData =>
      typeof entry === "object" &&
      entry !== null &&
      (entry.kind === "bullish" || entry.kind === "bearish") &&
      typeof entry.time === "number" &&
      Number.isFinite(entry.time) &&
      typeof entry.levelPrice === "number" &&
      Number.isFinite(entry.levelPrice) &&
      typeof entry.topPrice === "number" &&
      Number.isFinite(entry.topPrice) &&
      typeof entry.bottomPrice === "number" &&
      Number.isFinite(entry.bottomPrice) &&
      entry.topPrice > entry.bottomPrice &&
      entry.topPrice >= entry.levelPrice &&
      entry.levelPrice >= entry.bottomPrice &&
      (entry.displayMode === "boxes" || entry.displayMode === "lines") &&
      typeof entry.bubblePrice === "number" &&
      Number.isFinite(entry.bubblePrice) &&
      typeof entry.buyVolume === "number" &&
      Number.isFinite(entry.buyVolume) &&
      typeof entry.sellVolume === "number" &&
      Number.isFinite(entry.sellVolume) &&
      typeof entry.delta === "number" &&
      Number.isFinite(entry.delta) &&
      typeof entry.score === "number" &&
      Number.isFinite(entry.score),
  );
}

interface FVGHoverHitInput {
  crosshairTimeMs: number;
  cursorY: number;
  intervalMs: number;
  lastBarTime: number;
  priceToCoordinate: (price: number) => number | null;
}

export function hitFvgHover(
  event: FVGHoverData,
  input: FVGHoverHitInput,
): { distance: number; y: number } | null {
  const bubbleY = input.priceToCoordinate(event.bubblePrice);
  if (
    bubbleY !== null &&
    Math.abs(event.time - input.crosshairTimeMs) <= input.intervalMs / 2 &&
    Math.abs(bubbleY - input.cursorY) <= 24
  ) {
    return { distance: Math.abs(bubbleY - input.cursorY), y: bubbleY };
  }

  const firstTime = Math.min(event.time, input.lastBarTime);
  const lastTime = Math.max(event.time, input.lastBarTime);
  if (input.crosshairTimeMs < firstTime || input.crosshairTimeMs > lastTime) {
    return null;
  }

  if (event.displayMode === "boxes") {
    const topY = input.priceToCoordinate(event.topPrice);
    const bottomY = input.priceToCoordinate(event.bottomPrice);
    if (topY === null || bottomY === null) return null;
    const firstY = Math.min(topY, bottomY);
    const lastY = Math.max(topY, bottomY);
    if (input.cursorY < firstY || input.cursorY > lastY) return null;
    return {
      distance: Math.abs(input.cursorY - (firstY + lastY) / 2),
      y: input.cursorY,
    };
  }

  const levelY = input.priceToCoordinate(event.levelPrice);
  if (levelY === null) return null;
  const levelDistance = Math.abs(levelY - input.cursorY);
  return levelDistance <= 10 ? { distance: levelDistance, y: levelY } : null;
}
