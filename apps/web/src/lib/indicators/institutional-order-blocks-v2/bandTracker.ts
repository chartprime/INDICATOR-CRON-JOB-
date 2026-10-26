import { columnFlow, eachColumn, type ColumnFeed } from "../absorption-detector/absorptionColumns";
import { liquidityIndexAtOrAfter, type LiquidityColumn } from "../passive-liquidity/liquidityGrid";
import { DEATH_SHARE, HELD_MS, HOLE_MS, MEMORY_MS, REBUILD_MIN_MS, REFILL_BACK_SHARE, REFILL_DIP_SHARE, STRONG_EATEN_SHARE, STRONG_SIZE_KEEP_SHARE, WALL_COLUMN_MS, earnsGuard, type EndReason, type Side, type Wall } from "./institutionalV2Rules";

export { HOLE_MS };

export interface TrackerRules {
  bandRows: number;
  wallSize: number;
  strongSize: number;
  /** The wall size for one column, in place of `wallSize`: the absorption engine reads the heatmap's floor, which moves with the book. */
  wallSizeAt?: (column: LiquidityColumn) => number;
  /** The strong size for one column, in place of `strongSize`. */
  strongSizeAt?: (column: LiquidityColumn) => number;
  /** A band's size read the market's way, in place of the summed rows: an index band is its biggest row. */
  bandSizeOf?: (column: LiquidityColumn, side: Side, band: number) => number;
}

export interface BarClose {
  ts: number;
  row: number;
}

export interface BandTrackerState {
  lastTs: number | null;
  closedTs: number | null;
  open: Map<string, Wall>;
  memory: Map<string, Wall>;
  epoch: number | null;
  deepRead: { from: number; to: number; count: number } | null;
  folded: Set<number>;
  rebuiltAt: number | null;
}

export function createBandTracker(): BandTrackerState {
  return { lastTs: null, closedTs: null, open: new Map(), memory: new Map(), epoch: null, deepRead: null, folded: new Set(), rebuiltAt: null };
}

function reset(state: BandTrackerState): void {
  state.lastTs = null;
  state.closedTs = null;
  state.open.clear();
  state.memory.clear();
  state.deepRead = null;
  state.folded.clear();
}

function noteDeepRead(state: BandTrackerState, ts: number): void {
  if (state.deepRead === null) state.deepRead = { from: ts, to: ts, count: 1 };
  else {
    state.deepRead.to = ts;
    state.deepRead.count += 1;
  }
}

function historyChanged(state: BandTrackerState, feed: ColumnFeed): boolean {
  if (state.epoch !== null && feed.epoch !== state.epoch) return true;
  const deep = feed.deep;
  if (deep === null || state.lastTs === null) return false;
  const { columns } = deep;
  const read = state.deepRead;
  if (read !== null) {
    if (columns.length > 0 && columns[0].ts < read.from) return true;
    if (liquidityIndexAtOrAfter(columns, read.to + 1) - liquidityIndexAtOrAfter(columns, read.from) > read.count) return true;
  }
  for (let i = liquidityIndexAtOrAfter(columns, read === null ? -Infinity : read.to + 1); i < columns.length && columns[i].ts <= state.lastTs; i += 1) {
    if (!state.folded.delete(columns[i].ts)) return true;
    noteDeepRead(state, columns[i].ts);
  }
  return false;
}

export function wallTier(feed: ColumnFeed): ColumnFeed {
  return feed.deep === null ? feed : { epoch: feed.epoch, deep: null, fine: feed.deep };
}

function deepEdge(feed: ColumnFeed): number {
  const deep = feed.deep;
  if (deep === null || deep.columns.length === 0) return -Infinity;
  return deep.columns[deep.columns.length - 1].ts + deep.columnMs;
}

export function foldedColumns(feed: ColumnFeed, fromTs: number, toTs: number): LiquidityColumn[] {
  const { columns, columnMs } = feed.fine;
  const width = feed.deep?.columnMs ?? Math.max(columnMs, WALL_COLUMN_MS);
  if (columns.length === 0) return [];
  const start = Math.max(fromTs, deepEdge(feed));
  const latest = columns[columns.length - 1].ts + columnMs;
  if (columnMs >= width) return columns.filter((column) => column.ts >= start && column.ts <= toTs && column.ts + width <= latest);
  const out: LiquidityColumn[] = [];
  let index = liquidityIndexAtOrAfter(columns, Math.floor(start / width) * width);
  while (index < columns.length) {
    const windowTs = Math.floor(columns[index].ts / width) * width;
    if (windowTs > toTs || windowTs + width > latest) break;
    let end = index;
    while (end < columns.length && columns[end].ts < windowTs + width) end += 1;
    if (windowTs >= start) out.push(foldWindow(columns.slice(index, end), windowTs));
    index = end;
  }
  return out;
}

function foldWindow(columns: readonly LiquidityColumn[], ts: number): LiquidityColumn {
  let lo = Infinity;
  let hi = -Infinity;
  let reference = 0;
  let median = 0;
  for (const column of columns) {
    lo = Math.min(lo, column.lo);
    hi = Math.max(hi, column.hi);
    if (column.reference !== undefined && column.reference > reference) reference = column.reference;
    if (column.median !== undefined && column.median > median) median = column.median;
  }
  const bid = new Float64Array(hi - lo + 1);
  const ask = new Float64Array(hi - lo + 1);
  const buy: [number, number][] = [];
  const sell: [number, number][] = [];
  for (const column of columns) {
    for (let row = column.lo; row <= column.hi; row += 1) {
      const at = row - lo;
      const b = column.bid[row - column.lo];
      const a = column.ask[row - column.lo];
      if (b > bid[at]) bid[at] = b;
      if (a > ask[at]) ask[at] = a;
    }
    for (const entry of column.buy ?? []) buy.push([entry[0], entry[1]]);
    for (const entry of column.sell ?? []) sell.push([entry[0], entry[1]]);
  }
  const folded: LiquidityColumn = { ts, lo, hi, bid, ask, buy, sell };
  if (reference > 0) folded.reference = reference;
  if (median > 0) folded.median = median;
  return folded;
}

function bandSize(column: LiquidityColumn, side: Side, rowLo: number, rowHi: number): number {
  const cells = column[side];
  let size = 0;
  for (let row = Math.max(rowLo, column.lo); row <= Math.min(rowHi, column.hi); row += 1) size += cells[row - column.lo];
  return size;
}

function endWall(state: Pick<BandTrackerState, "open" | "memory">, key: string, wall: Wall, ts: number, reason: EndReason): void {
  wall.endTs = ts;
  wall.endReason = reason;
  state.open.delete(key);
  state.memory.set(key, wall);
}

function endAll(state: BandTrackerState, ts: number): void {
  for (const [key, wall] of state.open) if (!wall.guarded) endWall(state, key, wall, ts, "hole");
}

function forget(state: BandTrackerState, ts: number): void {
  for (const [key, wall] of state.memory) if (wall.endTs !== null && ts - wall.endTs > MEMORY_MS) state.memory.delete(key);
}

function openWall(state: BandTrackerState, key: string, side: Side, band: number, rows: number, ts: number, size: number): Wall {
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

export function readBands(state: BandTrackerState, feed: ColumnFeed, upTo: number, rules: TrackerRules, nowMs = Date.now(), closes: readonly BarClose[] = []): void {
  if (historyChanged(state, feed) && (state.rebuiltAt === null || nowMs - state.rebuiltAt >= REBUILD_MIN_MS)) {
    reset(state);
    state.rebuiltAt = nowMs;
  }
  state.epoch = feed.epoch;
  const rows = Math.max(1, Math.floor(rules.bandRows));
  const from = state.lastTs === null ? 0 : state.lastTs + 1;
  const visit = (column: LiquidityColumn): void => {
    applyCloses(state, closes, column.ts);
    if (state.lastTs !== null && column.ts - state.lastTs > HOLE_MS) endAll(state, state.lastTs);
    state.lastTs = column.ts;
    forget(state, column.ts);
    const wallSize = rules.wallSizeAt?.(column) ?? rules.wallSize;
    const strongSize = rules.strongSizeAt?.(column) ?? rules.strongSize;
    for (const side of ["bid", "ask"] as const) {
      const attack = side === "bid" ? "sell" : "buy";
      for (let band = Math.floor(column.lo / rows); band <= Math.floor(column.hi / rows); band += 1) {
        const rowLo = band * rows;
        const rowHi = rowLo + rows - 1;
        const size = rules.bandSizeOf?.(column, side, band) ?? bandSize(column, side, rowLo, rowHi);
        const key = `${side}:${band}`;
        let wall = state.open.get(key);
        if (!Number.isFinite(size)) {
          if (wall !== undefined) endWall(state, key, wall, column.ts, "hole");
          continue;
        }
        const opened = wall === undefined;
        if (wall === undefined) {
          if (size < wallSize) continue;
          wall = openWall(state, key, side, band, rows, column.ts, size);
        }
        wall.current = size;
        if (size > wall.peak) {
          wall.peak = size;
          wall.low = size;
        } else if (size < wall.low) {
          wall.low = size;
        }
        if (wall.low <= REFILL_DIP_SHARE * wall.peak && (size >= REFILL_BACK_SHARE * wall.peak || size - wall.low >= wallSize)) {
          wall.refills += 1;
          wall.refilled += size - wall.low;
          wall.low = size;
        }
        if (!opened) wall.eaten += columnFlow(column, attack, rowLo, rowHi);
        if (wall.crossedTs === null && wall.eaten >= STRONG_EATEN_SHARE * wall.peak) wall.crossedTs = column.ts;
        if (size >= strongSize) {
          wall.atStrongSize = true;
          wall.reachedStrongSize = true;
        } else if (size < STRONG_SIZE_KEEP_SHARE * strongSize) wall.atStrongSize = false;
        if (!wall.guarded && earnsGuard(wall)) wall.guarded = true;
        if (size < DEATH_SHARE * wall.peak && wall.eaten <= 0) endWall(state, key, wall, column.ts, "pulled");
      }
    }
    for (const [key, wall] of state.open) {
      if (wall.guarded) continue;
      if (wall.band * rows > column.hi || wall.band * rows + rows - 1 < column.lo) {
        wall.current = 0;
        endWall(state, key, wall, column.ts, "window");
      }
    }
  };
  const edge = deepEdge(feed);
  if (feed.deep !== null && from < edge) {
    eachColumn(wallTier(feed), from, Math.min(upTo - 1, edge - 1), (column) => {
      visit(column);
      noteDeepRead(state, column.ts);
    });
  }
  for (const column of foldedColumns(feed, from, upTo - 1)) {
    visit(column);
    state.folded.add(column.ts);
  }
  applyCloses(state, closes, upTo);
}

export function closeThrough(state: Pick<BandTrackerState, "open" | "memory">, closeRow: number, ts: number): void {
  for (const [key, wall] of state.open) if (isThrough(wall, closeRow)) endWall(state, key, wall, ts, "closed");
  for (const wall of state.memory.values()) if (wall.endReason !== "closed" && isThrough(wall, closeRow)) wall.endReason = "invalidated";
}

export function isThrough(wall: Wall, closeRow: number): boolean {
  const rowLo = wall.band * wall.bandRows;
  return wall.side === "bid" ? closeRow < rowLo : closeRow > rowLo + wall.bandRows - 1;
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

function applyCloses(state: BandTrackerState, closes: readonly BarClose[], until: number): void {
  for (let index = state.closedTs === null ? 0 : closeIndexAfter(closes, state.closedTs); index < closes.length; index += 1) {
    const close = closes[index];
    if (close.ts > until) break;
    closeThrough(state, close.row, close.ts);
    state.closedTs = close.ts;
  }
}

export function standingWalls(state: Pick<BandTrackerState, "open">, nowTs: number): Wall[] {
  const walls: Wall[] = [];
  for (const wall of state.open.values()) if (nowTs - wall.startTs >= HELD_MS) walls.push(wall);
  return walls;
}

export function mitigatedWalls(state: Pick<BandTrackerState, "memory">): Wall[] {
  const walls: Wall[] = [];
  for (const wall of state.memory.values()) if (wall.endReason === "closed" && wall.endTs !== null && wall.endTs - wall.startTs >= HELD_MS) walls.push(wall);
  return walls;
}
