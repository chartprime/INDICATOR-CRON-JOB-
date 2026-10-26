export const WHALE_MIN_RADIUS_PX = 6;
export const WHALE_MAX_RADIUS_PX = 28;
export const WHALE_BASE_RADIUS_PX = 12;
export const WHALE_RADIUS_PX_PER_DOUBLING = 5;
export const DEFAULT_MEDIAN_BUCKET_MS = 60 * 60 * 1000;
export const DEFAULT_MIN_BUCKET_SAMPLES = 3;

export interface NotionalPoint {
  ts: number;
  magnitude: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function computeLocalMedianBaselines(
  points: readonly NotionalPoint[],
  bucketMs: number = DEFAULT_MEDIAN_BUCKET_MS,
  minBucketSamples: number = DEFAULT_MIN_BUCKET_SAMPLES,
): number[] {
  if (!Number.isSafeInteger(bucketMs) || bucketMs <= 0) {
    throw new Error("computeLocalMedianBaselines: bucketMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(minBucketSamples) || minBucketSamples <= 0) {
    throw new Error("computeLocalMedianBaselines: minBucketSamples must be a positive safe integer");
  }
  const indicesByBucket = new Map<number, number[]>();
  points.forEach((point, index) => {
    const bucketKey = Math.floor(point.ts / bucketMs);
    const indices = indicesByBucket.get(bucketKey);
    if (indices) indices.push(index);
    else indicesByBucket.set(bucketKey, [index]);
  });

  const bucketKeys = [...indicesByBucket.keys()].sort((a, b) => a - b);

  const baselines = new Array<number>(points.length);
  for (const [bucketKey, indices] of indicesByBucket) {
    let pool = indices;
    const nearestBucketKeys = bucketKeys
      .filter((candidate) => candidate !== bucketKey)
      .sort((a, b) => Math.abs(a - bucketKey) - Math.abs(b - bucketKey) || a - b);
    for (const neighborKey of nearestBucketKeys) {
      if (pool.length >= minBucketSamples) break;
      pool = pool.concat(indicesByBucket.get(neighborKey)!);
    }
    const baseline = median(pool.map((index) => points[index].magnitude));
    for (const index of indices) {
      baselines[index] = baseline;
    }
  }
  return baselines;
}

export function whaleMarkerRadiusPx(
  magnitude: number,
  localMedianMagnitude: number,
  minRadiusPx: number = WHALE_MIN_RADIUS_PX,
  maxRadiusPx: number = WHALE_MAX_RADIUS_PX,
): number {
  if (!Number.isFinite(magnitude) || magnitude <= 0 || !Number.isFinite(localMedianMagnitude) || localMedianMagnitude <= 0) {
    return minRadiusPx;
  }
  const ratio = magnitude / localMedianMagnitude;
  const radius = WHALE_BASE_RADIUS_PX + WHALE_RADIUS_PX_PER_DOUBLING * Math.log2(ratio);
  return Math.min(Math.max(radius, minRadiusPx), maxRadiusPx);
}

export const WHALE_MIN_FILL_OPACITY = 0.55;
export const WHALE_MAX_FILL_OPACITY = 0.92;
export const WHALE_MAX_COUNT_FOR_FULL_OPACITY = 5;

export function whaleMarkerFillOpacity(
  count: number,
  minOpacity: number = WHALE_MIN_FILL_OPACITY,
  maxOpacity: number = WHALE_MAX_FILL_OPACITY,
  maxCountForFullOpacity: number = WHALE_MAX_COUNT_FOR_FULL_OPACITY,
): number {
  if (!Number.isFinite(count) || count <= 0) return minOpacity;
  if (maxCountForFullOpacity <= 1) return maxOpacity;
  const t = Math.min(Math.max(count - 1, 0) / (maxCountForFullOpacity - 1), 1);
  return minOpacity + t * (maxOpacity - minOpacity);
}

export interface WhaleHitCandidate<T> {
  x: number;
  y: number;
  radiusPx: number;
  value: T;
}

export function hitTestWhaleMarkers<T>(
  candidates: readonly WhaleHitCandidate<T>[],
  x: number,
  y: number,
  tolerancePx: number = 2,
): T | null {
  let closest: T | null = null;
  let closestDistance = Infinity;
  for (const candidate of candidates) {
    const dx = candidate.x - x;
    const dy = candidate.y - y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance <= candidate.radiusPx + tolerancePx && distance < closestDistance) {
      closest = candidate.value;
      closestDistance = distance;
    }
  }
  return closest;
}
