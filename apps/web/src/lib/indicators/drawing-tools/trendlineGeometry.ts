import type { DrawingPoint, DrawingToolId, TrendlineDrawing } from "../../chart/drawingStore";

export interface PixelSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export function trendlinePixelPoints(
  drawing: TrendlineDrawing,
  timeToCoordinate: (timeSeconds: number) => number | null,
  priceToCoordinate: (price: number) => number | null,
): PixelSegment | null {
  const [a, b] = drawing.points;
  const x1 = timeToCoordinate(a.time);
  const y1 = priceToCoordinate(a.price);
  const x2 = timeToCoordinate(b.time);
  const y2 = priceToCoordinate(b.price);
  if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
  return { x1, y1, x2, y2 };
}

export interface TrendlineHitCandidate {
  id: string;
  segment: PixelSegment;
}

function distanceToSegment(x: number, y: number, segment: PixelSegment): number {
  const { x1, y1, x2, y2 } = segment;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(x - x1, y - y1);
  const t = Math.min(Math.max(((x - x1) * dx + (y - y1) * dy) / lengthSquared, 0), 1);
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

export interface DrawingHit {
  id: string;
  distance: number;
}

export function hitTestTrendlines(
  candidates: readonly TrendlineHitCandidate[],
  x: number,
  y: number,
  tolerancePx: number = 4,
): DrawingHit | null {
  let closest: DrawingHit | null = null;
  for (const candidate of candidates) {
    const distance = distanceToSegment(x, y, candidate.segment);
    if (distance <= tolerancePx && (closest === null || distance < closest.distance)) {
      closest = { id: candidate.id, distance };
    }
  }
  return closest;
}

export function pickNearestHit(hits: readonly (DrawingHit | null)[]): string | null {
  let nearest: DrawingHit | null = null;
  for (const hit of hits) {
    if (hit !== null && (nearest === null || hit.distance < nearest.distance)) {
      nearest = hit;
    }
  }
  return nearest?.id ?? null;
}

export type DrawingPlacementMode =
  | { kind: "idle" }
  | { kind: "selected"; id: string }
  | { kind: "placing"; tool: DrawingToolId; first: DrawingPoint | null };

export type DrawingPlacementEvent =
  | { type: "setTool"; tool: DrawingToolId | null }
  | { type: "click"; point: DrawingPoint | null; hitId: string | null }
  | { type: "escape" }
  | { type: "deleteSelected" };

export interface DrawingPlacementResult {
  next: DrawingPlacementMode;
  commit: { first: DrawingPoint; second: DrawingPoint; tool: DrawingToolId } | null;
  removeId: string | null;
}

export const DRAWING_PLACEMENT_IDLE: DrawingPlacementMode = { kind: "idle" };

export function advanceDrawingPlacement(
  state: DrawingPlacementMode,
  event: DrawingPlacementEvent,
): DrawingPlacementResult {
  const noop: DrawingPlacementResult = { next: state, commit: null, removeId: null };

  switch (event.type) {
    case "setTool": {
      if (event.tool === null) return { next: { kind: "idle" }, commit: null, removeId: null };
      return { next: { kind: "placing", tool: event.tool, first: null }, commit: null, removeId: null };
    }
    case "click": {
      if (state.kind === "placing") {
        if (event.point === null) return noop;
        if (state.first === null) {
          return { next: { kind: "placing", tool: state.tool, first: event.point }, commit: null, removeId: null };
        }
        return {
          next: { kind: "placing", tool: state.tool, first: null },
          commit: { first: state.first, second: event.point, tool: state.tool },
          removeId: null,
        };
      }
      if (event.hitId !== null) return { next: { kind: "selected", id: event.hitId }, commit: null, removeId: null };
      return { next: { kind: "idle" }, commit: null, removeId: null };
    }
    case "escape": {
      if (state.kind === "placing" && state.first !== null) {
        return { next: { kind: "placing", tool: state.tool, first: null }, commit: null, removeId: null };
      }
      if (state.kind === "selected") {
        return { next: { kind: "idle" }, commit: null, removeId: null };
      }
      return noop;
    }
    case "deleteSelected": {
      if (state.kind === "selected") {
        return { next: { kind: "idle" }, commit: null, removeId: state.id };
      }
      return noop;
    }
  }
}

export function nearestSeriesTime(timeSeconds: number, seriesTimes: readonly number[]): number | null {
  if (seriesTimes.length === 0) return null;
  const first = seriesTimes[0];
  const last = seriesTimes[seriesTimes.length - 1];
  if (timeSeconds < first || timeSeconds > last) return null;
  let low = 0;
  let high = seriesTimes.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (seriesTimes[mid] <= timeSeconds) low = mid;
    else high = mid;
  }
  return timeSeconds - seriesTimes[low] <= seriesTimes[high] - timeSeconds ? seriesTimes[low] : seriesTimes[high];
}

export function snappedTimeToCoordinate(
  timeToCoordinate: (timeSeconds: number) => number | null,
  seriesTimes: readonly number[],
): (timeSeconds: number) => number | null {
  return (timeSeconds: number) => {
    const direct = timeToCoordinate(timeSeconds);
    if (direct !== null) return direct;
    const snapped = nearestSeriesTime(timeSeconds, seriesTimes);
    return snapped === null ? null : timeToCoordinate(snapped);
  };
}
