import type { LiquidityColumn, LiquiditySide } from "../passive-liquidity/liquidityGrid";

export type BandSizes = (column: LiquidityColumn, bandIndex: number, clusterRows: number) => { bid: number; ask: number };

export interface EmptyBookRules {
  clusterRows: number;
  minRows: number;
  bandSizes: BandSizes;
  thinShare: number;
  refillMultiple: number;
  averageMs: number;
  rejoinMs: number;
  showMs: number;
  flashMs: number;
  gapMs: number;
  typicalBp: number;
  reachBp: number;
  clearRows: number;
}

export const DEFAULT_EMPTY_BOOK_RULES: Omit<EmptyBookRules, "clusterRows" | "minRows" | "bandSizes"> = Object.freeze({
  thinShare: 0.75,
  refillMultiple: 1,
  averageMs: 120_000,
  rejoinMs: 15_000,
  showMs: 30_000,
  flashMs: 3_000,
  gapMs: 30_000,
  typicalBp: 50,
  reachBp: Infinity,
  clearRows: 4,
});

export const TYPICAL_KEEP_PER_SECOND = 0.9;
export const TYPICAL_MIN_ROWS = 10;
export const ROW_MARGIN = 16;

export interface EmptyBookZone {
  id: number;
  group: number;
  side: LiquiditySide;
  lo: number;
  hi: number;
  since: number;
  shown: boolean;
}

export interface EmptyBookFlash {
  side: LiquiditySide;
  row: number;
  ts: number;
  zone: number;
  since: number;
}

interface Sample {
  ts: number;
  lo: number;
  hi: number;
  bid: Float64Array;
  ask: Float64Array;
}

export interface EmptyBookState {
  clusterRows: number;
  samples: Sample[];
  base: number;
  sums: Record<LiquiditySide, Float64Array>;
  counts: Int32Array;
  knownCounts: Record<LiquiditySide, Int32Array>;
  window: { lo: number; hi: number } | null;
  typical: number;
  lastTs: number | null;
  startedTs: number | null;
  members: Record<LiquiditySide, Set<number>>;
  zones: Record<LiquiditySide, EmptyBookZone[]>;
  refilled: Record<LiquiditySide, Map<number, number>>;
  flashes: EmptyBookFlash[];
  nextId: number;
}

const SIDES: readonly LiquiditySide[] = ["ask", "bid"];

export function createEmptyBookState(clusterRows: number): EmptyBookState {
  return {
    clusterRows,
    samples: [],
    base: 0,
    sums: { ask: new Float64Array(0), bid: new Float64Array(0) },
    counts: new Int32Array(0),
    knownCounts: { ask: new Int32Array(0), bid: new Int32Array(0) },
    window: null,
    typical: 0,
    lastTs: null,
    startedTs: null,
    members: { ask: new Set(), bid: new Set() },
    zones: { ask: [], bid: [] },
    refilled: { ask: new Map(), bid: new Map() },
    flashes: [],
    nextId: 1,
  };
}

export function resetEmptyBook(state: EmptyBookState, clusterRows: number): void {
  state.clusterRows = clusterRows;
  state.samples = [];
  state.base = 0;
  state.sums = { ask: new Float64Array(0), bid: new Float64Array(0) };
  state.counts = new Int32Array(0);
  state.knownCounts = { ask: new Int32Array(0), bid: new Int32Array(0) };
  state.window = null;
  state.typical = 0;
  state.lastTs = null;
  state.startedTs = null;
  state.members.ask.clear();
  state.members.bid.clear();
  state.zones = { ask: [], bid: [] };
  state.refilled.ask.clear();
  state.refilled.bid.clear();
  state.flashes = [];
}

function sampleOf(column: LiquidityColumn, rules: EmptyBookRules, window: { lo: number; hi: number }): Sample {
  const rows = rules.clusterRows;
  const lo = Math.max(window.lo, Math.ceil(column.lo / rows));
  const hi = Math.min(window.hi, Math.floor((column.hi + 1) / rows) - 1);
  const count = Math.max(0, hi - lo + 1);
  const bid = new Float64Array(count);
  const ask = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    const sizes = rules.bandSizes(column, lo + i, rows);
    bid[i] = sizes.bid;
    ask[i] = sizes.ask;
  }
  return { ts: column.ts, lo, hi, bid, ask };
}

function fitRows(state: EmptyBookState, lo: number, hi: number): void {
  if (lo >= state.base && hi < state.base + state.counts.length) return;
  let from = lo;
  let to = hi;
  for (const sample of state.samples) {
    from = Math.min(from, sample.lo);
    to = Math.max(to, sample.hi);
  }
  const margin = Math.max(ROW_MARGIN, (to - from + 1) >> 2);
  const base = from - margin;
  const size = to - from + 1 + 2 * margin;
  const counts = new Int32Array(size);
  const bid = new Float64Array(size);
  const ask = new Float64Array(size);
  const start = Math.max(base, state.base);
  const end = Math.min(base + size, state.base + state.counts.length);
  if (end > start) {
    counts.set(state.counts.subarray(start - state.base, end - state.base), start - base);
    bid.set(state.sums.bid.subarray(start - state.base, end - state.base), start - base);
    ask.set(state.sums.ask.subarray(start - state.base, end - state.base), start - base);
  }
  for (const side of SIDES) {
    const known = new Int32Array(size);
    if (end > start) known.set(state.knownCounts[side].subarray(start - state.base, end - state.base), start - base);
    state.knownCounts[side] = known;
  }
  state.base = base;
  state.counts = counts;
  state.sums = { bid, ask };
}

function addSample(state: EmptyBookState, sample: Sample): void {
  fitRows(state, sample.lo, sample.hi);
  state.samples.push(sample);
  const offset = sample.lo - state.base;
  for (let i = 0; i < sample.bid.length; i += 1) {
    state.counts[offset + i] += 1;
    for (const side of SIDES) if (Number.isFinite(sample[side][i])) {
      state.sums[side][offset + i] += sample[side][i];
      state.knownCounts[side][offset + i] += 1;
    }
  }
}

function dropOldest(state: EmptyBookState): void {
  const sample = state.samples.shift();
  if (sample === undefined) return;
  const offset = sample.lo - state.base;
  for (let i = 0; i < sample.bid.length; i += 1) {
    const index = offset + i;
    const count = state.counts[index] - 1;
    state.counts[index] = count;
    for (const side of SIDES) if (Number.isFinite(sample[side][i])) {
      state.knownCounts[side][index] -= 1;
      state.sums[side][index] = state.knownCounts[side][index] <= 0 ? 0 : state.sums[side][index] - sample[side][i];
    }
  }
}

function covers(sample: Sample, row: number): boolean {
  return row >= sample.lo && row <= sample.hi;
}

function touchOf(column: LiquidityColumn): { bid: number; ask: number } | null {
  let bid = -1;
  for (let i = column.bid.length - 1; i >= 0; i -= 1) {
    if (column.bid[i] > 0) {
      bid = column.lo + i;
      break;
    }
  }
  let ask = -1;
  for (let i = 0; i < column.ask.length; i += 1) {
    if (column.ask[i] > 0) {
      ask = column.lo + i;
      break;
    }
  }
  return bid < 0 || ask < 0 ? null : { bid, ask };
}

function medianNear(sample: Sample, midRow: number, reach: number): number {
  const from = Math.max(sample.lo, midRow - reach);
  const to = Math.min(sample.hi, midRow + reach);
  const values = new Float64Array(2 * Math.max(0, to - from + 1));
  let count = 0;
  for (let row = from; row <= to; row += 1) {
    const i = row - sample.lo;
    if (sample.bid[i] > 0) values[count++] = sample.bid[i];
    if (sample.ask[i] > 0) values[count++] = sample.ask[i];
  }
  if (count === 0) return 0;
  return values.subarray(0, count).sort()[Math.round(0.5 * (count - 1))];
}

function averageOf(state: EmptyBookState, side: LiquiditySide, row: number): number | null {
  const index = row - state.base;
  const count = state.knownCounts[side][index];
  if (count !== state.samples.length) return null;
  return state.sums[side][index] / count;
}

function runsOf(members: ReadonlySet<number>, minRows: number): [number, number][] {
  const rows = Float64Array.from(members).sort();
  const runs: [number, number][] = [];
  for (const row of rows) {
    const last = runs[runs.length - 1];
    if (last !== undefined && row === last[1] + 1) last[1] = row;
    else runs.push([row, row]);
  }
  return runs.filter(([lo, hi]) => hi - lo + 1 >= minRows);
}

function overlap(zone: EmptyBookZone, lo: number, hi: number): number {
  return Math.min(zone.hi, hi) - Math.max(zone.lo, lo) + 1;
}

function zonesOf(state: EmptyBookState, side: LiquiditySide, runs: readonly [number, number][], ts: number, rules: EmptyBookRules): EmptyBookZone[] {
  const previous = [...state.zones[side]].sort((a, b) => a.since - b.since || a.id - b.id);
  const ids: (number | null)[] = runs.map(() => null);
  for (const zone of previous) {
    let best = -1;
    let most = 0;
    runs.forEach(([lo, hi], index) => {
      const shared = overlap(zone, lo, hi);
      if (ids[index] === null && shared > most) {
        best = index;
        most = shared;
      }
    });
    if (best >= 0) ids[best] = zone.id;
  }
  return runs.map(([lo, hi], index) => {
    let since = ts;
    let group: number | null = null;
    for (const zone of previous) {
      if (overlap(zone, lo, hi) <= 0) continue;
      if (zone.since < since) since = zone.since;
      group ??= zone.group;
    }
    const id = ids[index] ?? state.nextId++;
    return { id, group: group ?? id, side, lo, hi, since, shown: ts - since >= rules.showMs };
  });
}

function stepSide(state: EmptyBookState, side: LiquiditySide, edge: number, reach: number, full: boolean, rules: EmptyBookRules): void {
  const now = state.samples[state.samples.length - 1];
  const ts = now.ts;
  const direction = side === "ask" ? 1 : -1;
  const limit = Math.min(reach, Math.max(0, side === "ask" ? now.hi - edge : edge - now.lo));
  const members = state.members[side];
  const thin = rules.thinShare * state.typical;
  const refill = rules.refillMultiple * state.typical;
  const release = (thin + refill) / 2;
  const refilled = state.refilled[side];
  for (const [row, at] of refilled) {
    if (!Number.isFinite(now[side][row - now.lo])) { refilled.delete(row); continue; }
    if (now[side][row - now.lo] >= thin) refilled.set(row, ts);
    else if (ts - at >= rules.rejoinMs) refilled.delete(row);
  }

  for (const row of [...members]) {
    if (!Number.isFinite(now[side][row - now.lo])) { members.delete(row); continue; }
    const distance = (row - edge) * direction;
    if (distance <= rules.clearRows || distance > limit) {
      members.delete(row);
      continue;
    }
    const average = averageOf(state, side, row);
    if (now[side][row - now.lo] < refill && (average === null || average < release)) continue;
    members.delete(row);
    refilled.set(row, ts);
    const zone = state.zones[side].find((candidate) => candidate.shown && row >= candidate.lo && row <= candidate.hi);
    if (zone !== undefined) state.flashes.push({ side, row, ts, zone: zone.id, since: zone.since });
  }

  if (full) {
    for (let distance = rules.clearRows + 2; distance <= limit; distance += 1) {
      const row = edge + direction * distance;
      if (members.has(row) || refilled.has(row) || !covers(now, row)) continue;
      if (!Number.isFinite(now[side][row - now.lo]) || now[side][row - now.lo] >= thin) continue;
      const average = averageOf(state, side, row);
      if (average !== null && average < thin) members.add(row);
    }
  }

  state.zones[side] = zonesOf(state, side, runsOf(members, rules.minRows), ts, rules);
}

export function stepEmptyBook(state: EmptyBookState, column: LiquidityColumn, rules: EmptyBookRules, columnMs = 0): void {
  if (state.lastTs !== null && column.ts <= state.lastTs) return;
  if (rules.clusterRows !== state.clusterRows) resetEmptyBook(state, rules.clusterRows);
  if (state.lastTs !== null && column.ts - state.lastTs > rules.gapMs) resetEmptyBook(state, rules.clusterRows);
  const step = state.lastTs === null ? columnMs : column.ts - state.lastTs;
  state.lastTs = column.ts;
  state.startedTs ??= column.ts;
  const ts = column.ts;
  state.flashes = state.flashes.filter((flash) => ts - flash.ts < rules.flashMs);

  const rows = rules.clusterRows;
  const touch = touchOf(column);
  const midRow = touch === null ? 0 : (touch.bid + touch.ask + 1) / 2;
  const bands = (bp: number) => Math.max(1, Math.round((midRow * bp) / 10_000 / rows));
  const edges: Record<LiquiditySide, number> | null = touch === null ? null : {
    ask: Math.floor(Math.max(touch.ask, touch.bid + 1) / rows),
    bid: Math.floor(Math.min(touch.bid, touch.ask - 1) / rows),
  };
  const reach = bands(rules.reachBp);
  const typicalRows = Math.max(bands(rules.typicalBp), TYPICAL_MIN_ROWS);
  const room = Math.max(reach, typicalRows) + 1;
  const window = edges === null ? state.window : { lo: edges.bid - room, hi: edges.ask + room };
  if (window === null) return;
  state.window = window;
  const sample = sampleOf(column, rules, window);
  addSample(state, sample);
  while (state.samples[0].ts <= ts - rules.averageMs) dropOldest(state);

  if (touch === null || edges === null) return;
  const median = medianNear(sample, Math.floor(midRow / rows), typicalRows);
  if (median > 0) {
    const keep = TYPICAL_KEEP_PER_SECOND ** (Math.max(step, 1) / 1_000);
    state.typical = state.typical <= 0 ? median : median + keep * (state.typical - median);
  }
  if (state.typical <= 0) return;

  const full = ts - state.startedTs >= rules.averageMs - columnMs;
  for (const side of SIDES) stepSide(state, side, edges[side], reach, full, rules);
}

export function emptyBookZones(state: EmptyBookState): EmptyBookZone[] {
  return [...state.zones.ask, ...state.zones.bid].filter((zone) => zone.shown);
}

export function emptiestWindow(state: EmptyBookState, zone: Pick<EmptyBookZone, "side" | "lo" | "hi">, rows: number): number {
  const size = Math.max(1, Math.min(Math.floor(rows), zone.hi - zone.lo + 1));
  const starts: number[] = [];
  for (let lo = zone.lo; lo + size - 1 <= zone.hi; lo += 1) starts.push(lo);
  if (zone.side === "bid") starts.reverse();
  let best = starts[0];
  let least = Infinity;
  for (const lo of starts) {
    let sum = 0;
    for (let row = lo; row < lo + size; row += 1) sum += averageOf(state, zone.side, row) ?? Infinity;
    if (sum < least) {
      least = sum;
      best = lo;
    }
  }
  return best;
}

export function emptyBookFlashes(state: EmptyBookState): readonly EmptyBookFlash[] {
  return state.flashes;
}

export function zoneRows(zone: Pick<EmptyBookZone, "lo" | "hi">, clusterRows: number): { rowLo: number; rowHi: number } {
  return { rowLo: zone.lo * clusterRows, rowHi: (zone.hi + 1) * clusterRows - 1 };
}
