export interface HistoricalZoneRange {
  rangeStartTs: number;
  rangeEndTs: number;
}

export const MAX_HISTORICAL_ZONES = 50;

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

export function alignedPeriodBoundaries(
  visibleFromMs: number,
  visibleToMs: number,
  periodMs: number,
  excludeFromMs: number,
  maxBlocks: number = MAX_HISTORICAL_ZONES,
): HistoricalZoneRange[] {
  if (
    !isFiniteNumber(visibleFromMs) ||
    !isFiniteNumber(visibleToMs) ||
    !isFiniteNumber(excludeFromMs) ||
    visibleToMs < visibleFromMs
  ) {
    return [];
  }
  if (!Number.isFinite(periodMs) || periodMs <= 0) {
    throw new Error(
      "volumeProfileZones: periodMs must be a positive finite number",
    );
  }
  if (!Number.isInteger(maxBlocks) || maxBlocks <= 0) {
    throw new Error("volumeProfileZones: maxBlocks must be a positive integer");
  }

  const blocks: HistoricalZoneRange[] = [];
  const lastBoundary =
    Math.floor((Math.min(visibleToMs, excludeFromMs) - 1) / periodMs) *
    periodMs;
  const firstWanted = Math.floor(visibleFromMs / periodMs) * periodMs;










  let boundary = lastBoundary;
  while (boundary >= firstWanted && blocks.length < maxBlocks) {
    if (boundary < excludeFromMs) {
      const rangeEndTs = Math.min(boundary + periodMs, excludeFromMs);
      if (rangeEndTs > boundary) {
        blocks.push({ rangeStartTs: boundary, rangeEndTs });
      }
    }
    boundary -= periodMs;
  }


  blocks.reverse();
  return blocks;
}
