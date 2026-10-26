import type { L2Wall, L2WallDetail, L2WallVerdict } from "./types";

export const HOST_WALL_ID_BASE = 2 ** 40;
export const WALL_VERDICTS: readonly L2WallVerdict[] = Object.freeze(["filled", "partial", "hit", "pulled", "moved"] as const);
const VERDICTS: ReadonlySet<string> = new Set(WALL_VERDICTS);
const MAX_WALLS = 400;
export const MAX_WALL_FILTER_USD = 1e12;

export interface WallFilter {
  readonly minUsd: number;
  readonly alwaysOutcomes: readonly L2WallVerdict[];
}

export interface WallSizeBands {
  readonly n: number;
  readonly p50: number;
  readonly p75: number;
  readonly p90: number;
  readonly p95: number;
  readonly p99: number;
}

export type HostWallPage =
  | { readonly available: true; readonly generation: string | null; readonly rowWidth: number; readonly walls: readonly L2Wall[]; readonly next: { readonly endTs: number; readonly id: number } | null; readonly filter?: WallFilter; readonly sizeBands?: WallSizeBands }
  | { readonly available: false; readonly reason: string };

function sizeBandsOf(value: unknown): WallSizeBands | null {
  if (!isRecord(value)) return null;
  const { n, p50, p75, p90, p95, p99 } = value;
  if (!isSafeInteger(n) || n < 1) return null;
  const ladder = [p50, p75, p90, p95, p99];
  if (!ladder.every((step): step is number => typeof step === "number" && Number.isFinite(step) && step > 0)) return null;
  for (let index = 1; index < ladder.length; index += 1) if ((ladder[index] as number) < (ladder[index - 1] as number)) return null;
  return Object.freeze({ n, p50: p50 as number, p75: p75 as number, p90: p90 as number, p95: p95 as number, p99: p99 as number });
}

export function isWallFilter(value: unknown): value is WallFilter {
  if (!isRecord(value)) return false;
  const { minUsd, alwaysOutcomes } = value;
  if (typeof minUsd !== "number" || !Number.isFinite(minUsd) || minUsd < 0 || minUsd > MAX_WALL_FILTER_USD) return false;
  if (!Array.isArray(alwaysOutcomes) || alwaysOutcomes.length > WALL_VERDICTS.length) return false;
  return new Set(alwaysOutcomes).size === alwaysOutcomes.length && alwaysOutcomes.every((outcome) => typeof outcome === "string" && VERDICTS.has(outcome));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableInt(value: unknown): number | null {
  return isSafeInteger(value) ? value : null;
}

function continuityGapOf(value: Record<string, unknown>): number | null {
  const stored = isRecord(value.continuity) ? nullableInt(value.continuity.gapMs) : null;
  return stored ?? nullableInt(value.continuityGapMs);
}

function detailOf(value: unknown): L2WallDetail | null {
  if (!isRecord(value)) return null;
  return Object.freeze({
    lifeMs: nullableInt(value.lifeMs),
    firstShrinkTs: nullableInt(value.firstShrinkTs),
    firstShrinkExact: value.firstShrinkExact === true,
    reachedAtFirstShrink: typeof value.reachedAtFirstShrink === "boolean" ? value.reachedAtFirstShrink : null,
    traded: finite(value.traded, 0),
    absorbed: finite(value.absorbed, 0),
    swept: finite(value.swept, 0),
    hidden: finite(value.hidden, 0),
    cleared: finite(value.cleared, 0),
    fillRatio: finite(value.fillRatio, 0),
    crossSide: finite(value.crossSide, 0),
    crossSideShare: finite(value.crossSideShare, 0),
    endDistanceRows: nullableInt(value.endDistanceRows),
    endDistancePct: typeof value.endDistancePct === "number" && Number.isFinite(value.endDistancePct) ? value.endDistancePct : null,
    clearedByTrades: value.clearedByTrades === true,
    continuityGapMs: continuityGapOf(value),
    repeats: finite(value.repeats, 0),
    repeatsComplete: value.repeatsComplete === true,
    evidenceGap: value.evidenceGap === true,
  });
}

export function hostWallId(id: number): number {
  return -(HOST_WALL_ID_BASE + id);
}

function wallOf(value: unknown): L2Wall | null {
  if (!isRecord(value)) return null;
  if (!isSafeInteger(value.id) || value.id < 0) return null;
  if (value.side !== "bid" && value.side !== "ask") return null;
  if (!isSafeInteger(value.row) || !isSafeInteger(value.span) || value.span < 1) return null;
  if (!isSafeInteger(value.startTs) || value.startTs < 0 || !isSafeInteger(value.endTs) || value.endTs < value.startTs) return null;
  if (typeof value.endedBy !== "string" || !VERDICTS.has(value.endedBy)) return null;
  const size = finite(value.size, NaN);
  const peak = finite(value.peak, NaN);
  if (!(size >= 0) || !(peak >= 0)) return null;
  return Object.freeze({
    id: hostWallId(value.id),
    lane: 0,
    side: value.side,
    row: value.row,
    span: value.span,
    startTs: value.startTs,
    endTs: value.endTs,
    size,
    peak,
    endedBy: value.endedBy as L2WallVerdict,
    ratio: finite(value.ratio, 0),
    chain: finite(value.chain, 0),
    fill: finite(value.fill, 0),
    eaten: finite(value.eaten, 0),
    absorbing: value.absorbing === true,
    detail: detailOf(value.detail),
  });
}

export function decodeHostWallPage(raw: unknown): HostWallPage | null {
  if (!isRecord(raw)) return null;
  if (raw.available === false) return typeof raw.reason === "string" ? { available: false, reason: raw.reason } : null;
  if (raw.available !== true) return null;
  const { generation = null, geometry, walls, next } = raw;
  if (generation !== null && (typeof generation !== "string" || generation.length === 0 || generation.length > 64)) return null;
  if (!isRecord(geometry) || typeof geometry.rowWidth !== "number" || !(geometry.rowWidth > 0) || !Number.isFinite(geometry.rowWidth)) return null;
  if (!Array.isArray(walls) || walls.length > MAX_WALLS) return null;
  if (!(next === null || next === undefined || (isRecord(next) && isSafeInteger(next.endTs) && isSafeInteger(next.id)))) return null;
  const decoded: L2Wall[] = [];
  for (const value of walls) {
    const wall = wallOf(value);
    if (wall === null) return null;
    decoded.push(wall);
  }
  const echo = isWallFilter(raw.filter) ? Object.freeze({ minUsd: raw.filter.minUsd, alwaysOutcomes: Object.freeze([...raw.filter.alwaysOutcomes]) }) : null;
  const bands = sizeBandsOf(raw.sizeBands);
  return Object.freeze({
    available: true,
    generation: generation as string | null,
    rowWidth: geometry.rowWidth,
    walls: Object.freeze(decoded),
    next: next === null || next === undefined ? null : Object.freeze({ endTs: (next as { endTs: number }).endTs, id: (next as { id: number }).id }),
    ...(echo === null ? {} : { filter: echo }),
    ...(bands === null ? {} : { sizeBands: bands }),
  });
}
