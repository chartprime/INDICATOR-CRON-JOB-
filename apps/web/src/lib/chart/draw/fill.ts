export interface FillPoint {
  time: number;
  valueA: number;
  valueB: number;
}

export interface FillOptions {
  colorAbove?: string;
  colorBelow?: string;
}

/**
 * The key `ctx.draw.fill` files a band under when it is not given one, so an
 * indicator that fills a single region never has to name it.
 */
export const DEFAULT_FILL_KEY = "fill";

export interface FillSegmentPoint {
  x: number;
  yA: number;
  yB: number;
}

export interface FillSegment {
  points: readonly FillSegmentPoint[];
  color: string;
}

export const DEFAULT_FILL_COLOR_ABOVE = "rgba(38, 166, 154, 0.2)";
export const DEFAULT_FILL_COLOR_BELOW = "rgba(239, 83, 80, 0.2)";

type CoordinateFn = (value: number) => number | null;

export function pushFillPoint(points: (FillPoint | null)[], point: FillPoint | null): void {
  points.push(point);
}

export function overwriteLastFillPoint(points: (FillPoint | null)[], point: FillPoint | null): void {
  if (points.length === 0) {
    points.push(point);
    return;
  }
  points[points.length - 1] = point;
}

export function visibleFillPoints(
  points: readonly (FillPoint | null)[],
  fromMs: number,
  toMs: number,
  margin = 3,
): readonly (FillPoint | null)[] {
  let first = -1;
  let last = -1;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (point === null) continue;
    if (first === -1 && point.time >= fromMs) first = index;
    if (point.time <= toMs) last = index;
  }
  if (first === -1) first = points.length;
  const start = Math.max(0, Math.min(first, last + 1) - margin);
  const end = Math.min(points.length, Math.max(last, first - 1) + margin + 1);
  return points.slice(start, end);
}

export function resetFillPoints(points: (FillPoint | null)[]): void {
  points.length = 0;
}

/**
 * Splits into disjoint segments at every null gap and at every sign flip of
 * (valueA - valueB), so a band that crosses its own other side is drawn with
 * the correct above/below color on each side of the crossing rather than one
 * segment stretched across it.
 */
export function computeFillPolygon(
  points: readonly (FillPoint | null)[],
  timeToCoordinate: CoordinateFn,
  priceToCoordinate: CoordinateFn,
  options: FillOptions = {},
): FillSegment[] {
  const colorAbove = options.colorAbove ?? DEFAULT_FILL_COLOR_ABOVE;
  const colorBelow = options.colorBelow ?? DEFAULT_FILL_COLOR_BELOW;

  const segments: FillSegment[] = [];
  let current: FillSegmentPoint[] = [];
  let currentSide: "above" | "below" | null = null;
  let previousPoint: FillPoint | null = null;

  function flush(): void {
    if (current.length >= 2) {
      segments.push({ points: current, color: currentSide === "below" ? colorBelow : colorAbove });
    }
    current = [];
  }

  for (const point of points) {
    if (point === null) {
      flush();
      currentSide = null;
      previousPoint = null;
      continue;
    }
    const x = timeToCoordinate(point.time);
    const yA = priceToCoordinate(point.valueA);
    const yB = priceToCoordinate(point.valueB);
    if (x === null || yA === null || yB === null) {
      flush();
      currentSide = null;
      previousPoint = null;
      continue;
    }
    const side: "above" | "below" = point.valueA >= point.valueB ? "above" : "below";
    if (currentSide !== null && side !== currentSide && previousPoint !== null) {
      // Split at the true line intersection. Splitting at the next candle
      // paints part of the cloud with the wrong above/below color.
      const previousDelta = previousPoint.valueA - previousPoint.valueB;
      const currentDelta = point.valueA - point.valueB;
      const ratio = previousDelta / (previousDelta - currentDelta);
      const crossingTime = previousPoint.time + ratio * (point.time - previousPoint.time);
      const crossingValueA = previousPoint.valueA + ratio * (point.valueA - previousPoint.valueA);
      const crossingValueB = previousPoint.valueB + ratio * (point.valueB - previousPoint.valueB);
      const crossingX = timeToCoordinate(crossingTime);
      const crossingYA = priceToCoordinate(crossingValueA);
      const crossingYB = priceToCoordinate(crossingValueB);
      if (crossingX !== null && crossingYA !== null && crossingYB !== null) {
        const crossing = { x: crossingX, yA: crossingYA, yB: crossingYB };
        current.push(crossing);
        flush();
        current = [crossing, { x, yA, yB }];
      } else {
        flush();
        current = [{ x, yA, yB }];
      }
      currentSide = side;
      previousPoint = point;
      continue;
    }
    current.push({ x, yA, yB });
    currentSide = side;
    previousPoint = point;
  }
  flush();
  return segments;
}
