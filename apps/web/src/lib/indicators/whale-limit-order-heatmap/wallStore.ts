import type { L2Wall, L2WallVerdict } from "../../l2/types";

export const WHALE_OUTCOMES: readonly L2WallVerdict[] = Object.freeze(["filled", "partial", "hit", "pulled", "moved"] as const);
export const WHALE_RETENTION_MS = 8 * 86_400_000;

export interface WhaleBands {
  readonly p50: number;
  readonly p75: number;
  readonly p90: number;
  readonly p95: number;
  readonly p99: number;
}

export type WhaleSideFilter = "both" | 0 | 1;

export interface WhaleWall {
  readonly key: string;
  readonly side: 0 | 1;
  readonly start: number;
  readonly end: number;
  readonly lo: number;
  readonly hi: number;
  readonly peak: number;
  readonly usd: number;
  readonly outcome: number;
  readonly source: "host" | "live";
  readonly wall: L2Wall;
}

export interface StandingWall {
  readonly key: string;
  readonly side: 0 | 1;
  readonly start: number;
  readonly lo: number;
  readonly hi: number;
  readonly peak: number;
  readonly usd: number;
  readonly wall: L2Wall;
}

export interface SelectionOptions {
  readonly cutUsd: number;
  readonly ratioMin?: number | null;
  readonly fills: boolean;
  readonly outcomes: readonly boolean[];
  readonly side: WhaleSideFilter;
  readonly fromTs: number;
  readonly bands: WhaleBands;
}

export interface Selection {
  readonly count: number;
  readonly walls: readonly WhaleWall[];
  readonly start: Float64Array;
  readonly end: Float64Array;
  readonly lo: Float64Array;
  readonly hi: Float64Array;
  readonly prefixEnd: Float64Array;
  readonly side: Uint8Array;
  readonly outcome: Uint8Array;
  readonly heat: Float32Array;
  readonly standing: readonly StandingWall[];
  readonly standingHeat: Float32Array;
}

export function wallKey(wall: L2Wall): string {
  return `${wall.side}|${wall.row}|${wall.span}|${wall.startTs}`;
}

export function wallUsd(wall: L2Wall, rowWidth: number): number {
  return wall.peak * (wall.row + wall.span / 2) * rowWidth;
}

export function heatOf(usd: number, bands: WhaleBands): number {
  const floor = bands.p50;
  const span = Math.log(bands.p99 / floor);
  if (!(floor > 0) || !(span > 0)) return 0;
  return Math.max(0, Math.min(1, Math.log(Math.max(usd, floor) / floor) / span));
}

function outcomeIndex(verdict: L2WallVerdict | null): number {
  return verdict === null ? -1 : WHALE_OUTCOMES.indexOf(verdict);
}

function endedOf(wall: L2Wall, rowWidth: number, source: "host" | "live"): WhaleWall | null {
  if (wall.endTs === null) return null;
  const outcome = outcomeIndex(wall.endedBy);
  if (outcome < 0 || !(rowWidth > 0)) return null;
  return {
    key: wallKey(wall),
    side: wall.side === "bid" ? 0 : 1,
    start: wall.startTs,
    end: wall.endTs,
    lo: wall.row * rowWidth,
    hi: (wall.row + wall.span) * rowWidth,
    peak: wall.peak,
    usd: wallUsd(wall, rowWidth),
    outcome,
    source,
    wall,
  };
}

function standingOf(wall: L2Wall, rowWidth: number): StandingWall {
  return {
    key: wallKey(wall),
    side: wall.side === "bid" ? 0 : 1,
    start: wall.startTs,
    lo: wall.row * rowWidth,
    hi: (wall.row + wall.span) * rowWidth,
    peak: wall.peak,
    usd: wallUsd(wall, rowWidth),
    wall,
  };
}

export function visibleRange(selection: Selection, fromMs: number, toMs: number): readonly [number, number] {
  const { count, prefixEnd, start } = selection;
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prefixEnd[mid] < fromMs) lo = mid + 1;
    else hi = mid;
  }
  const first = lo;
  lo = first;
  hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (start[mid] <= toMs) lo = mid + 1;
    else hi = mid;
  }
  return [first, lo];
}

function levelOf(wall: WhaleWall): string {
  return `${wall.side}|${wall.wall.row}|${wall.wall.span}`;
}

function overlaps(a: WhaleWall, b: WhaleWall): boolean {
  return a.start < b.end && b.start < a.end;
}

export class WhaleWallStore {
  private readonly _ended = new Map<string, WhaleWall>();
  private readonly _levels = new Map<string, Set<string>>();
  private _standing: StandingWall[] = [];
  private _version = 0;

  get version(): number {
    return this._version;
  }

  get size(): number {
    return this._ended.size;
  }

  get standingCount(): number {
    return this._standing.length;
  }

  get levelCount(): number {
    return this._levels.size;
  }

  clear(): void {
    this._ended.clear();
    this._levels.clear();
    this._standing = [];
    this._version += 1;
  }

  addHost(walls: readonly L2Wall[], rowWidth: number): number {
    return this._addEnded(walls, rowWidth, "host");
  }

  addLive(walls: readonly L2Wall[], rowWidth: number): number {
    const standing: StandingWall[] = [];
    const ended: L2Wall[] = [];
    for (const wall of walls) {
      if (wall.endTs === null) standing.push(standingOf(wall, rowWidth));
      else ended.push(wall);
    }
    const changedStanding = standing.length !== this._standing.length || standing.some((wall, index) => wall.key !== this._standing[index]?.key || wall.peak !== this._standing[index]?.peak);
    this._standing = standing;
    const added = this._addEnded(ended, rowWidth, "live");
    if (changedStanding && added === 0) this._version += 1;
    return added;
  }

  addHistorical(walls: readonly L2Wall[], rowWidth: number, multiplier: number): void {
    if (!(multiplier > 0) || !Number.isFinite(multiplier)) throw new Error("qualified notional multiplier required");
    this.clear();
    const usdOf = (wall: L2Wall) => wall.peak * (wall.row + (wall.span - 1) / 2) * rowWidth * multiplier;
    for (const wall of walls) {
      if (wall.endTs === null) this._standing.push({ ...standingOf(wall, rowWidth), key: `historical:${wall.id}`, usd: usdOf(wall) });
      else {
        const record = endedOf(wall, rowWidth, "host");
        if (record !== null) this._put({ ...record, key: `historical:${wall.id}`, usd: usdOf(wall) });
      }
    }
  }

  clearStanding(): void {
    if (this._standing.length === 0) return;
    this._standing = [];
    this._version += 1;
  }

  prune(olderThanEnd: number): number {
    let dropped = 0;
    for (const wall of [...this._ended.values()]) {
      if (wall.end < olderThanEnd) {
        this._remove(wall);
        dropped += 1;
      }
    }
    if (dropped > 0) this._version += 1;
    return dropped;
  }

  private _remove(wall: WhaleWall): void {
    this._ended.delete(wall.key);
    const level = this._levels.get(levelOf(wall));
    if (level === undefined) return;
    level.delete(wall.key);
    if (level.size === 0) this._levels.delete(levelOf(wall));
  }

  private _put(record: WhaleWall): void {
    this._ended.set(record.key, record);
    const level = levelOf(record);
    const keys = this._levels.get(level);
    if (keys === undefined) this._levels.set(level, new Set([record.key]));
    else keys.add(record.key);
  }

  private _overlapping(record: WhaleWall, source: "host" | "live"): WhaleWall[] {
    const keys = this._levels.get(levelOf(record));
    if (keys === undefined) return [];
    const found: WhaleWall[] = [];
    for (const key of keys) {
      const other = this._ended.get(key);
      if (other !== undefined && key !== record.key && other.source === source && overlaps(record, other)) found.push(other);
    }
    return found;
  }

  private _addEnded(walls: readonly L2Wall[], rowWidth: number, source: "host" | "live"): number {
    let changed = 0;
    for (const wall of walls) {
      const record = endedOf(wall, rowWidth, source);
      if (record === null) continue;
      const held = this._ended.get(record.key);
      if (held !== undefined) {
        if (held.source === "host" && source === "live") continue;
        const keepsHeld = held.source === source && record.end - record.start <= held.end - held.start;
        if (keepsHeld) continue;
      }
      if (source === "live" && this._overlapping(record, "host").length > 0) continue;
      if (source === "host") for (const copy of this._overlapping(record, "live")) this._remove(copy);
      this._put(record);
      changed += 1;
    }
    if (changed > 0) this._version += 1;
    return changed;
  }

  select(options: SelectionOptions): Selection {
    const { cutUsd, fills, outcomes, side, fromTs, bands } = options;
    const ratioMin = options.ratioMin ?? null;
    const kept: WhaleWall[] = [];
    for (const wall of this._ended.values()) {
      if (wall.end < fromTs) continue;
      if (!outcomes[wall.outcome]) continue;
      if (side !== "both" && wall.side !== side) continue;
      const big = ratioMin === null ? wall.usd >= cutUsd : wall.wall.ratio >= ratioMin;
      if (!big && !(fills && wall.outcome <= 1)) continue;
      kept.push(wall);
    }
    kept.sort((a, b) => a.start - b.start || a.end - b.end);
    const count = kept.length;
    const start = new Float64Array(count);
    const end = new Float64Array(count);
    const lo = new Float64Array(count);
    const hi = new Float64Array(count);
    const prefixEnd = new Float64Array(count);
    const sideOf = new Uint8Array(count);
    const outcome = new Uint8Array(count);
    const heat = new Float32Array(count);
    let furthest = 0;
    for (let index = 0; index < count; index += 1) {
      const wall = kept[index];
      start[index] = wall.start;
      end[index] = wall.end;
      lo[index] = wall.lo;
      hi[index] = wall.hi;
      furthest = Math.max(furthest, wall.end);
      prefixEnd[index] = furthest;
      sideOf[index] = wall.side;
      outcome[index] = wall.outcome;
      heat[index] = heatOf(wall.usd, bands);
    }
    const standing = this._standing
      .filter((wall) => (ratioMin === null ? wall.usd >= cutUsd : wall.wall.ratio >= ratioMin) && (side === "both" || wall.side === side))
      .sort((a, b) => b.usd - a.usd);
    const standingHeat = new Float32Array(standing.length);
    for (let index = 0; index < standing.length; index += 1) standingHeat[index] = heatOf(standing[index].usd, bands);
    return { count, walls: kept, start, end, lo, hi, prefixEnd, side: sideOf, outcome, heat, standing, standingHeat };
  }
}
