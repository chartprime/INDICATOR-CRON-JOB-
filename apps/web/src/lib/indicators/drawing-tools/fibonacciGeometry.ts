import type { DrawingPoint, FibonacciDrawing } from "../../chart/drawingStore";
import type { TrendlineHitCandidate } from "./trendlineGeometry";

export const FIBONACCI_LEVELS: readonly number[] = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

export function fibonacciLevelPrice(pointA: DrawingPoint, pointB: DrawingPoint, fraction: number): number {
  return pointB.price + fraction * (pointA.price - pointB.price);
}

export interface FibonacciPixelLevel {
  fraction: number;
  price: number;
  x1: number;
  x2: number;
  y: number;
}

export function fibonacciPixelLevels(
  drawing: FibonacciDrawing,
  timeToCoordinate: (timeSeconds: number) => number | null,
  priceToCoordinate: (price: number) => number | null,
): FibonacciPixelLevel[] | null {
  const [a, b] = drawing.points;
  const x1 = timeToCoordinate(a.time);
  const x2 = timeToCoordinate(b.time);
  if (x1 === null || x2 === null) return null;
  const levels: FibonacciPixelLevel[] = [];
  for (const fraction of FIBONACCI_LEVELS) {
    const price = fibonacciLevelPrice(a, b, fraction);
    const y = priceToCoordinate(price);
    if (y === null) return null;
    levels.push({ fraction, price, x1, x2, y });
  }
  return levels;
}

export function fibonacciHitCandidates(id: string, levels: readonly FibonacciPixelLevel[]): TrendlineHitCandidate[] {
  return levels.map((level) => ({
    id,
    segment: { x1: level.x1, y1: level.y, x2: level.x2, y2: level.y },
  }));
}
