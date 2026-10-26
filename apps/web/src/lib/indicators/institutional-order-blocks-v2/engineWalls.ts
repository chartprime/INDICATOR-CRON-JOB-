import type { IndicatorL2 } from "../../chart/indicatorL2";
import type { L2Wall, L2WallVerdict } from "../../l2/types";
import { isThrough, type BarClose, type TrackerRules } from "./bandTracker";
import { MEMORY_MS, REFILL_BACK_SHARE, REFILL_DIP_SHARE, STRONG_EATEN_SHARE, STRONG_SIZE_KEEP_SHARE, earnsGuard, type Side, type Wall } from "./institutionalV2Rules";

export type EngineReason = "no-l2" | "historical" | "untrusted" | null;

export interface EngineWallsState {
  version: number | null;
  segmentId: string | null;
  seenSeq: number | undefined;
  lastTs: number | null;
  closedTs: number | null;
  open: Map<string, Wall>;
  memory: Map<string, Wall>;
  ids: Map<number, string>;
  traded: Map<string, Map<number, number>>;
  base: Map<string, number>;
  underSize: Map<string, Map<number, number>>;
  adopted: Set<number>;
  approximate: Set<string>;
  reason: EngineReason;
  memoryMs: number;
}

interface Band {
  size: number;
  started: number;
  traded: Map<number, number>;
}

export function createEngineWalls(memoryMs = MEMORY_MS): EngineWallsState {
  return {
    version: null, segmentId: null, seenSeq: undefined, lastTs: null, closedTs: null, open: new Map(), memory: new Map(), ids: new Map(),
    traded: new Map(), base: new Map(), underSize: new Map(), adopted: new Set(), approximate: new Set(), reason: "no-l2", memoryMs,
  };
}

function reset(state: EngineWallsState): void {
  state.version = null;
  state.segmentId = null;
  state.seenSeq = undefined;
  state.lastTs = null;
  state.closedTs = null;
  state.open.clear();
  state.memory.clear();
  state.ids.clear();
  state.traded.clear();
  state.base.clear();
  state.underSize.clear();
  state.adopted.clear();
  state.approximate.clear();
}

export function bandOf(wall: Pick<L2Wall, "row" | "span">, rows: number): number {
  return Math.floor((wall.row + (wall.span - 1) / 2) / rows);
}

export function keyOf(side: Side, band: number): string {
  return `${side}:${band}`;
}

function pairOf(segmentId: string): string {
  const parts = segmentId.split(":");
  return parts.slice(0, parts.length - 2).join(":");
}

export function isPull(verdict: L2WallVerdict | null): boolean {
  return verdict === "pulled" || verdict === "hit" || verdict === "moved";
}

function endWall(state: EngineWallsState, key: string, wall: Wall, ts: number, reason: Wall["endReason"]): void {
  wall.endTs = ts;
  wall.endReason = reason;
  wall.current = 0;
  state.open.delete(key);
  state.memory.set(key, wall);
  state.traded.delete(key);
  state.base.delete(key);
  state.approximate.delete(key);
}

function forget(state: EngineWallsState, ts: number): void {
  for (const [key, wall] of state.memory) if (wall.endTs !== null && ts - wall.endTs > state.memoryMs) state.memory.delete(key);
}

function openWall(state: EngineWallsState, key: string, side: Side, band: number, rows: number, ts: number, size: number): Wall {
  const remembered = state.memory.get(key);
  if (remembered !== undefined && remembered.endReason !== "closed" && remembered.endReason !== "invalidated") {
    state.memory.delete(key);
    if (remembered.endReason === "pulled") {
      remembered.refills += 1;
      remembered.refilled += size;
      remembered.crossedTs = null;
      remembered.reachedStrongSize = false;
      remembered.peak = size;
    }
    remembered.endTs = null;
    remembered.endReason = null;
    remembered.atStrongSize = false;
    remembered.resumedTs = ts;
    remembered.low = size;
    state.open.set(key, remembered);
    return remembered;
  }
  const wall: Wall = { side, band, bandRows: rows, startTs: ts, resumedTs: ts, peak: size, current: size, low: size, eaten: 0, refills: 0, refilled: 0, crossedTs: null, atStrongSize: false, reachedStrongSize: false, guarded: false, endTs: null, endReason: null };
  state.open.set(key, wall);
  return wall;
}

function closeIndexAfter(closes: readonly BarClose[], ts: number): number {
  let lo = 0;
  let hi = closes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (closes[mid].ts <= ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function applyCloses(state: EngineWallsState, closes: readonly BarClose[], until: number): void {
  for (let index = state.closedTs === null ? 0 : closeIndexAfter(closes, state.closedTs); index < closes.length; index += 1) {
    const close = closes[index];
    if (close.ts > until) break;
    closeThroughAfter(state, close.row, close.ts);
    state.closedTs = close.ts;
  }
}

function closeAdopted(state: EngineWallsState, adopted: readonly (readonly [string, Wall])[], closes: readonly BarClose[]): void {
  const until = state.closedTs;
  if (until === null) return;
  for (const [key, wall] of adopted) {
    for (let index = closeIndexAfter(closes, wall.startTs - 1); index < closes.length && closes[index].ts <= until; index += 1) {
      const close = closes[index];
      if (state.open.get(key) === wall) {
        if (wall.resumedTs <= close.ts && isThrough(wall, close.row)) endWall(state, key, wall, close.ts, "closed");
      } else if (wall.endReason !== "closed" && wall.endTs !== null && wall.endTs <= close.ts && isThrough(wall, close.row)) {
        wall.endReason = "invalidated";
        break;
      }
    }
  }
}

function closeThroughAfter(state: EngineWallsState, closeRow: number, ts: number): void {
  for (const [key, wall] of [...state.open]) if (wall.resumedTs <= ts && isThrough(wall, closeRow)) endWall(state, key, wall, ts, "closed");
  for (const wall of state.memory.values()) if (wall.endReason !== "closed" && wall.endTs !== null && wall.endTs <= ts && isThrough(wall, closeRow)) wall.endReason = "invalidated";
}

function tradedOf(state: EngineWallsState, key: string): number {
  let sum = 0;
  for (const amount of state.traded.get(key)?.values() ?? []) sum += amount;
  return sum;
}

function eatenOf(state: EngineWallsState, key: string): number {
  return (state.base.get(key) ?? 0) + tradedOf(state, key);
}

function consumeEvents(state: EngineWallsState, l2: IndicatorL2): boolean {
  const slice = l2.events(state.seenSeq);
  state.seenSeq = slice.seq;
  if (!slice.complete) return false;
  const running = new Map<string, number>();
  for (const event of slice.events) {
    if (event.kind !== "wall_trade") continue;
    const key = state.ids.get(event.wall);
    const wall = key === undefined ? undefined : state.open.get(key);
    if (key === undefined || wall === undefined) continue;
    const total = (running.get(key) ?? wall.eaten) + event.size;
    running.set(key, total);
    if (wall.crossedTs === null && total >= STRONG_EATEN_SHARE * wall.peak) {
      wall.crossedTs = event.ts;
      state.approximate.delete(key);
    }
  }
  return true;
}

function windowRows(l2: IndicatorL2): readonly [number, number] | null {
  const zero = l2.lanes().find((info) => info.lane === 0);
  if (zero === undefined || !(zero.rowWidth > 0)) return null;
  return [Math.round(zero.priceLo / zero.rowWidth), Math.round(zero.priceHi / zero.rowWidth) - 1];
}

function noteSegment(state: EngineWallsState, l2: IndicatorL2, nowTs: number): void {
  const segment = l2.segment();
  if (segment === null) return;
  if (state.segmentId !== null && segment.id !== state.segmentId) {
    if (pairOf(segment.id) !== pairOf(state.segmentId)) reset(state);
    else {
      for (const [key, wall] of [...state.open]) if (!wall.guarded) endWall(state, key, wall, state.lastTs ?? nowTs, "hole");
      state.ids.clear();
      state.seenSeq = undefined;
    }
  }
  state.segmentId = segment.id;
}

export function readEngine(state: EngineWallsState, l2: IndicatorL2 | undefined, rules: TrackerRules, nowTs: number, closes: readonly BarClose[] = []): EngineReason {
  if (l2 === undefined) return (state.reason = "no-l2");
  if (l2.availability === "HISTORICAL_UNAVAILABLE") return (state.reason = "historical");
  if (!l2.trusted()) return (state.reason = "untrusted");
  if (l2.availability === "HISTORICAL" && state.segmentId !== null && state.segmentId !== l2.segment()?.id) reset(state);
  noteSegment(state, l2, nowTs);
  state.reason = null;
  if (l2.version !== state.version) {
    state.version = l2.version;
    readWalls(state, l2, rules, nowTs);
  }
  applyCloses(state, closes, nowTs);
  forget(state, nowTs);
  return null;
}

export function adoptHistory(state: EngineWallsState, walls: readonly L2Wall[], rules: TrackerRules, closes: readonly BarClose[] = []): number {
  const rows = Math.max(1, Math.floor(rules.bandRows));
  const before = state.adopted.size;
  closeAdopted(state, adoptEnded(state, walls.filter((wall) => wall.id < 0), rules, rows), closes);
  return state.adopted.size - before;
}

function adoptEnded(state: EngineWallsState, ended: readonly L2Wall[], rules: TrackerRules, rows: number): [string, Wall][] {
  const adopted: [string, Wall][] = [];
  const past = ended.filter((wall) => !state.adopted.has(wall.id) && state.ids.get(wall.id) === undefined && wall.endTs !== null).sort((a, b) => a.startTs - b.startTs || a.id - b.id);
  for (const wall of past) {
    state.adopted.add(wall.id);
    if (wall.peak < rules.wallSize) continue;
    const key = keyOf(wall.side, bandOf(wall, rows));
    if (state.open.has(key)) continue;
    const traded = wall.detail?.traded ?? 0;
    const band = openWall(state, key, wall.side, bandOf(wall, rows), rows, wall.startTs, wall.peak);
    state.base.set(key, band.eaten + traded);
    band.eaten = eatenOf(state, key);
    band.current = 0;
    if (band.peak >= rules.strongSize) band.reachedStrongSize = true;
    if (!band.guarded && earnsGuard(band)) band.guarded = true;
    if (band.eaten <= 0 && isPull(wall.endedBy)) endWall(state, key, band, wall.endTs as number, "pulled");
    adopted.push([key, band]);
  }
  return adopted;
}

function collectBands(state: EngineWallsState, l2: IndicatorL2, rows: number): { bands: Map<string, Band>; verdicts: Map<string, L2WallVerdict>; ended: L2Wall[]; seen: Set<number> } {
  const bands = new Map<string, Band>();
  const verdicts = new Map<string, L2WallVerdict>();
  const ended: L2Wall[] = [];
  const seen = new Set<number>();
  for (const wall of l2.walls()) {
    seen.add(wall.id);
    const key = keyOf(wall.side, bandOf(wall, rows));
    const traded = wall.detail?.traded ?? 0;
    if (wall.endTs === null) {
      const band = bands.get(key) ?? { size: 0, started: wall.startTs, traded: new Map() };
      band.size += wall.size;
      band.started = Math.min(band.started, wall.startTs);
      band.traded.set(wall.id, traded);
      bands.set(key, band);
      state.ids.set(wall.id, key);
      continue;
    }
    const life = state.traded.get(state.ids.get(wall.id) ?? "");
    if (life?.has(wall.id)) life.set(wall.id, traded);
    if (state.ids.get(wall.id) === key && wall.endedBy !== null) verdicts.set(key, wall.endedBy);
    else if (state.ids.get(wall.id) === undefined && !state.adopted.has(wall.id)) ended.push(wall);
  }
  return { bands, verdicts, ended, seen };
}

function readWalls(state: EngineWallsState, l2: IndicatorL2, rules: TrackerRules, nowTs: number): void {
  const ts = l2.status("l2_walls").lastTs ?? nowTs;
  state.lastTs = ts;
  const rows = Math.max(1, Math.floor(rules.bandRows));
  forget(state, ts);
  const { bands, verdicts, ended, seen } = collectBands(state, l2, rows);
  adoptEnded(state, ended, rules, rows);
  const complete = consumeEvents(state, l2);
  for (const [key, band] of bands) {
    let wall = state.open.get(key);
    const opened = wall === undefined;
    if (wall === undefined) {
      if (band.size < rules.wallSize) {
        state.underSize.set(key, band.traded);
        continue;
      }
      const [side, index] = key.split(":");
      wall = openWall(state, key, side as Side, Number(index), rows, band.started, band.size);
    } else if (band.started < wall.startTs) {
      if (wall.resumedTs === wall.startTs) wall.resumedTs = band.started;
      wall.startTs = band.started;
    }
    const life = state.traded.get(key) ?? new Map<number, number>();
    for (const [id, amount] of band.traded) life.set(id, amount);
    state.traded.set(key, life);
    if (opened) {
      let before = 0;
      for (const [id, amount] of state.underSize.get(key) ?? []) if (band.traded.has(id)) before += amount;
      state.base.set(key, wall.eaten - before);
      state.underSize.delete(key);
    }
    const size = band.size;
    wall.current = size;
    if (size > wall.peak) {
      wall.peak = size;
      wall.low = size;
    } else if (size < wall.low) wall.low = size;
    if (wall.low <= REFILL_DIP_SHARE * wall.peak && (size >= REFILL_BACK_SHARE * wall.peak || size - wall.low >= rules.wallSize)) {
      wall.refills += 1;
      wall.refilled += size - wall.low;
      wall.low = size;
    }
    wall.eaten = eatenOf(state, key);
    if (wall.crossedTs === null && wall.eaten >= STRONG_EATEN_SHARE * wall.peak) {
      wall.crossedTs = ts;
      if (!complete) state.approximate.add(key);
    }
    if (size >= rules.strongSize) {
      wall.atStrongSize = true;
      wall.reachedStrongSize = true;
    } else if (size < STRONG_SIZE_KEEP_SHARE * rules.strongSize) wall.atStrongSize = false;
    if (!wall.guarded && earnsGuard(wall)) wall.guarded = true;
  }
  for (const [key, wall] of [...state.open]) {
    if (bands.has(key)) continue;
    wall.eaten = eatenOf(state, key);
    wall.current = 0;
    if (wall.eaten <= 0 && (isPull(verdicts.get(key) ?? null) || !verdicts.has(key))) endWall(state, key, wall, ts, "pulled");
  }
  const window = windowRows(l2);
  if (window !== null) {
    for (const [key, wall] of [...state.open]) {
      if (wall.guarded) continue;
      if (wall.band * rows > window[1] || wall.band * rows + rows - 1 < window[0]) endWall(state, key, wall, ts, "window");
    }
  }
  for (const key of [...state.underSize.keys()]) if (!bands.has(key)) state.underSize.delete(key);
  for (const [id, key] of [...state.ids]) {
    if (state.open.has(key) || state.underSize.has(key)) continue;
    state.ids.delete(id);
    state.adopted.add(id);
  }
  for (const id of [...state.adopted]) if (!seen.has(id)) state.adopted.delete(id);
}

export function isApproximate(state: EngineWallsState, wall: Wall): boolean {
  return state.approximate.has(keyOf(wall.side, wall.band));
}
