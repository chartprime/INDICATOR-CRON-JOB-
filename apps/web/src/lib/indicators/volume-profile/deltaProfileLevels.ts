import type { ProfileBucket } from "../../../types/frames";
import type { BinOpacityBand } from "./profileLevelLabels";

export const DEFAULT_DELTA_VALUE_AREA_PCT = 0.7;

export const MIN_VALUE_AREA_PCT = 0.1;
export const MAX_VALUE_AREA_PCT = 1;

export const VALUE_AREA_BIN_OPACITY: BinOpacityBand = { min: 0.8, max: 1 };
export const OUTSIDE_VALUE_AREA_BIN_OPACITY: BinOpacityBand = {
  min: 0.35,
  max: 0.7,
};

export interface DeltaProfileLevels {
  pocPrice: number;
  vahPrice: number;
  valPrice: number;
  maxAbsDelta: number;
}

export function bucketDelta(bucket: ProfileBucket): number {
  return bucket.buy_volume - bucket.sell_volume;
}

const EMPTY_LEVELS: DeltaProfileLevels = {
  pocPrice: Number.NaN,
  vahPrice: Number.NaN,
  valPrice: Number.NaN,
  maxAbsDelta: 0,
};

const LEVELS_CACHE = new WeakMap<
  readonly ProfileBucket[],
  Map<number, DeltaProfileLevels>
>();

export function computeDeltaLevels(
  buckets: readonly ProfileBucket[],
  valueAreaPct: number = DEFAULT_DELTA_VALUE_AREA_PCT,
): DeltaProfileLevels {
  if (buckets.length === 0) return EMPTY_LEVELS;
  if (!Number.isFinite(valueAreaPct) || valueAreaPct <= 0 || valueAreaPct > 1) {
    throw new Error(
      "deltaProfileLevels: valueAreaPct must be a finite number in (0, 1]",
    );
  }

  let byPercent = LEVELS_CACHE.get(buckets);
  const cached = byPercent?.get(valueAreaPct);
  if (cached !== undefined) return cached;

  const rows = [...buckets]
    .map((bucket) => ({
      price: bucket.price,
      abs: Math.abs(bucketDelta(bucket)),
    }))
    .sort((a, b) => a.price - b.price);

  let maxAbsDelta = 0;
  for (const row of rows) {
    if (row.abs > maxAbsDelta) maxAbsDelta = row.abs;
  }
  if (maxAbsDelta <= 0) return { ...EMPTY_LEVELS, pocPrice: rows[0].price };

  const totalAbs = rows.reduce((sum, row) => sum + row.abs, 0);
  const targetAbs = totalAbs * valueAreaPct;

  const midpoint = (rows[0].price + rows[rows.length - 1].price) / 2;
  let pocIndex = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const best = rows[pocIndex];
    const next = rows[index];
    if (next.abs > best.abs) {
      pocIndex = index;
      continue;
    }
    if (next.abs < best.abs) continue;
    const nextDistance = Math.abs(next.price - midpoint);
    const bestDistance = Math.abs(best.price - midpoint);
    if (
      nextDistance < bestDistance ||
      (nextDistance === bestDistance && next.price < best.price)
    ) {
      pocIndex = index;
    }
  }

  let vaHigh = pocIndex;
  let vaLow = pocIndex;
  let vaAbs = rows[pocIndex].abs;
  while (vaAbs < targetAbs && (vaHigh < rows.length - 1 || vaLow > 0)) {
    const canExpandAbove = vaHigh < rows.length - 1;
    const canExpandBelow = vaLow > 0;
    const aboveAbs = canExpandAbove ? rows[vaHigh + 1].abs : -1;
    const belowAbs = canExpandBelow ? rows[vaLow - 1].abs : -1;
    if (canExpandAbove && aboveAbs >= belowAbs) {
      vaHigh += 1;
      vaAbs += aboveAbs;
    } else if (canExpandBelow) {
      vaLow -= 1;
      vaAbs += belowAbs;
    } else {
      vaHigh += 1;
      vaAbs += aboveAbs;
    }
  }

  const levels: DeltaProfileLevels = {
    pocPrice: rows[pocIndex].price,
    vahPrice: rows[vaHigh].price,
    valPrice: rows[vaLow].price,
    maxAbsDelta,
  };
  if (byPercent === undefined) {
    byPercent = new Map();
    LEVELS_CACHE.set(buckets, byPercent);
  }
  byPercent.set(valueAreaPct, levels);
  return levels;
}
