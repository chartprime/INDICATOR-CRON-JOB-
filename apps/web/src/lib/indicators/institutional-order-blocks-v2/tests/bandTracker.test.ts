import { describe, expect, it } from "vitest";
import type { ColumnFeed } from "../../absorption-detector/absorptionColumns";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import { HOLE_MS, closeThrough, createBandTracker, foldedColumns, mitigatedWalls, readBands, standingWalls, type BandTrackerState, type BarClose, type TrackerRules } from "../bandTracker";
import { HELD_MS, MEMORY_MS, REBUILD_MIN_MS, STRONG_HOLD_MS } from "../institutionalV2Rules";

const T = 1_700_000_000_000;
const S = 1_000;
const STEP = 10 * S;
const LO = 90;
const HI = 115;

// Rows are one price wide, so a row is its price. Bands are four rows: band 25 is rows 100..103, band 26 is 104..107.
// A wall is a band summing to 10; no size makes one strong on its own unless a test says so.
const RULES: TrackerRules = { bandRows: 4, wallSize: 10, strongSize: Infinity };

interface Spec {
  bid?: Record<number, number>;
  ask?: Record<number, number>;
  buy?: [row: number, size: number][];
  sell?: [row: number, size: number][];
}

function column(ts: number, spec: Spec = {}, lo = LO, hi = HI): LiquidityColumn {
  const bid = new Float64Array(hi - lo + 1);
  const ask = new Float64Array(hi - lo + 1);
  for (const [row, size] of Object.entries(spec.bid ?? {})) if (Number(row) >= lo && Number(row) <= hi) bid[Number(row) - lo] = size;
  for (const [row, size] of Object.entries(spec.ask ?? {})) if (Number(row) >= lo && Number(row) <= hi) ask[Number(row) - lo] = size;
  return { ts, lo, hi, bid, ask, buy: spec.buy ?? [], sell: spec.sell ?? [] };
}

/** Columns every STEP from `fromS` to `toS` seconds around T, inclusive. */
function series(fromS: number, toS: number, spec: (s: number) => Spec, window?: [number, number]): LiquidityColumn[] {
  const out: LiquidityColumn[] = [];
  for (let s = fromS; s <= toS; s += STEP / S) out.push(column(T + s * S, spec(s), window?.[0], window?.[1]));
  return out;
}

function feedOf(columns: LiquidityColumn[], deep: LiquidityColumn[] | null = null): ColumnFeed {
  return { epoch: 1, deep: deep ? { columns: deep, columnMs: STEP } : null, fine: { columns, columnMs: STEP } };
}

const WALL: Spec = { bid: { 101: 6, 102: 6 } };
const HIT: Spec = { sell: [[101, 2], [102, 2]] };

function merge(...specs: Spec[]): Spec {
  return specs.reduce((a, b) => ({
    bid: { ...a.bid, ...b.bid },
    ask: { ...a.ask, ...b.ask },
    buy: [...(a.buy ?? []), ...(b.buy ?? [])],
    sell: [...(a.sell ?? []), ...(b.sell ?? [])],
  }), {} as Spec);
}

function read(columns: LiquidityColumn[], { upTo = T + 1000 * S, state = createBandTracker(), rules = RULES, deep = null as LiquidityColumn[] | null, closes = [] as BarClose[] } = {}) {
  readBands(state, feedOf(columns, deep), upTo, rules, undefined, closes);
  return state;
}

const bidWall = (state: BandTrackerState, band = 25) => state.open.get(`bid:${band}`);

describe("readBands opens and holds", () => {
  it("opens a wall the first column a band's rows sum to the wall size, and not on one row short of it", () => {
    const state = read(series(0, 100, (s) => (s >= 50 ? WALL : { bid: { 101: 6 } })));
    expect(bidWall(state)).toMatchObject({ side: "bid", band: 25, bandRows: 4, startTs: T + 50 * S, peak: 12, current: 12 });
  });

  it("holds the size as a minimum: a band one under it stays closed, one at it opens", () => {
    expect(read(series(0, 10, () => ({ bid: { 101: 5, 102: 4 } }))).open.size).toBe(0);
    expect(read(series(0, 10, () => ({ bid: { 101: 5, 102: 5 } }))).open.size).toBe(1);
  });

  it("sums the whole band: three rows of four make a wall where no row is one", () => {
    const state = read(series(0, 10, () => ({ bid: { 100: 4, 101: 4, 102: 4 } })));
    expect(bidWall(state)?.peak).toBe(12);
  });

  it("counts a wall as standing only once it has stood the held age", () => {
    const columns = series(0, 300, () => WALL);
    const state = read(columns);
    expect(standingWalls(state, T + HELD_MS - S)).toHaveLength(0);
    expect(standingWalls(state, T + HELD_MS)).toHaveLength(1);
  });

  it("reads the asks for an ask wall, and its bids do not make one", () => {
    const state = read(series(0, 10, () => ({ ask: { 101: 6, 102: 6 }, bid: { 101: 6 } })));
    expect(state.open.get("ask:25")).toMatchObject({ side: "ask", peak: 12 });
    expect(state.open.get("bid:25")).toBeUndefined();
  });

  it("takes the width from the rules, so the same rows are one wall at four and none at two", () => {
    const columns = series(0, 10, () => ({ bid: { 100: 3, 101: 3, 102: 3, 103: 3 } }));
    expect(read(columns).open.size).toBe(1);
    expect(read(columns, { rules: { ...RULES, bandRows: 2 } }).open.size).toBe(0);
  });
});

describe("readBands follows a wall", () => {
  it("keeps the peak as the most the band held and current as what it holds now", () => {
    const state = read(series(0, 100, (s) => ({ bid: { 101: 6, 102: s >= 50 ? 14 : 6 } }))) ;
    expect(bidWall(state)).toMatchObject({ peak: 20, current: 20 });
    const eaten = read(series(0, 100, (s) => ({ bid: { 101: 6, 102: s >= 50 ? 1 : 6 } })));
    expect(bidWall(eaten)).toMatchObject({ peak: 12, current: 7 });
  });

  it("ends a wall nothing has traded into the column its band falls to a tenth of the peak, and drops it from the open walls", () => {
    const columns = series(0, 100, (s) => (s >= 60 ? { bid: { 101: 1 } } : WALL));
    const state = read(columns);
    expect(bidWall(state)).toBeUndefined();
    expect(standingWalls(state, T + 1000 * S)).toHaveLength(0);
  });

  it("keeps a wall that has thinned to more than a tenth of its peak", () => {
    const state = read(series(0, 100, (s) => (s >= 60 ? { bid: { 101: 2 } } : WALL)));
    expect(bidWall(state)).toMatchObject({ current: 2 });
  });

  it("counts eaten from the other side into the band's rows only, from birth, and not before the wall opened", () => {
    const columns = series(0, 100, (s) => merge(s >= 20 ? WALL : {}, s === 10 || s === 30 ? HIT : {}, s === 40 ? { sell: [[105, 9]], buy: [[101, 9]] } : {}));
    expect(bidWall(read(columns))?.eaten).toBe(4);
  });

  it("marks the crossing the first column eaten reaches sixty percent of the peak, and leaves it there when the peak grows after", () => {
    const columns = series(0, 200, (s) => merge(s >= 100 ? { bid: { 101: 6, 102: 30 } } : WALL, s === 20 || s === 40 ? { sell: [[101, 4]] } : {}));
    const state = read(columns);
    // 4 at 20 s is a third of 12; 8 at 40 s is two thirds: crossed at 40 s. The peak rising to 36 later does not move it.
    expect(bidWall(state)).toMatchObject({ crossedTs: T + 40 * S, peak: 36, eaten: 8 });
  });

  it("judges the crossing against the peak, not the thinned size now", () => {
    // 5 traded is under sixty percent of the 12 peak, though over sixty percent of the 7 the band has thinned to.
    const columns = series(0, 100, (s) => merge(s >= 40 ? { bid: { 101: 1, 102: 6 } } : WALL, s === 20 ? { sell: [[101, 5]] } : {}));
    expect(bidWall(read(columns))).toMatchObject({ peak: 12, current: 7, eaten: 5, crossedTs: null });
  });

  it("does not count what traded in the column that opens the wall, so it cannot cross there either", () => {
    // The column is ten seconds of the book and the wall was posted somewhere inside them: the selling in those
    // seconds is mostly what happened before it was there. A wall born as price sweeps through stands fresh.
    const state = read(series(0, 10, (s) => merge(WALL, s === 0 ? { sell: [[101, 8]] } : {})));
    expect(bidWall(state)).toMatchObject({ eaten: 0, crossedTs: null });
  });

  it("counts from the column after the one it opened on, and nothing of the sweep that made it", () => {
    // Born at 20 s while eight sells through its rows; four more at 30 s, once it stands, are its own.
    const state = read(series(0, 100, (s) => merge(s >= 20 ? WALL : {}, s === 20 ? { sell: [[101, 8]] } : {}, s === 30 ? HIT : {})));
    expect(bidWall(state)).toMatchObject({ startTs: T + 20 * S, eaten: 4 });
  });

  it("does not count the column a wall comes back on either", () => {
    // The window leaves its rows and comes back at 210 s with selling in that very column: not the wall's.
    const away = [...series(0, 100, () => WALL), ...series(110, 200, () => ({ bid: { 112: 6, 113: 6 } }), [110, 135]), ...series(210, 300, (s) => merge(WALL, s === 210 ? { sell: [[101, 5]] } : {}))];
    expect(bidWall(read(away))).toMatchObject({ resumedTs: T + 210 * S, eaten: 0 });
  });
});

describe("readBands continues", () => {
  it("reads in pieces to the same answer as in one go", () => {
    const columns = series(0, 300, (s) => merge(WALL, s === 100 ? HIT : {}));
    const whole = read(columns, { upTo: T + 400 * S });
    const state = createBandTracker();
    for (const upTo of [T + 50 * S, T + 150 * S, T + 400 * S]) read(columns, { state, upTo });
    expect([...state.open.values()]).toEqual([...whole.open.values()]);
    expect(state.lastTs).toBe(whole.lastTs);
  });

  it("ends every open wall at a gap longer than the hole tolerance; a band still at size after it is the same wall come back, its life restarted", () => {
    const columns = series(0, 1000, (s) => merge(WALL, s === 50 ? HIT : {})).filter((c) => c.ts <= T + 100 * S || c.ts >= T + 100 * S + HOLE_MS + STEP);
    const state = read(columns, { upTo: T + 1100 * S });
    expect(bidWall(state)).toMatchObject({ startTs: T, resumedTs: T + 100 * S + HOLE_MS + STEP, refills: 0 });
    expect(standingWalls(state, T + 100 * S + HOLE_MS + STEP)).toHaveLength(1);
    expect(state.memory.size).toBe(0);
  });

  it("bridges a gap within the tolerance: the wall keeps its birth, its count, and the age it earns across it", () => {
    // Five minutes missing from 100 s: the wall was there before and after, so it stood through them.
    const columns = series(0, 1000, (s) => merge(WALL, s === 50 ? HIT : {})).filter((c) => c.ts <= T + 100 * S || c.ts >= T + 400 * S);
    const state = read(columns, { upTo: T + 1100 * S });
    expect(bidWall(state)?.startTs).toBe(T);
    expect(bidWall(state)?.eaten).toBe(4);
    expect(standingWalls(state, T + 400 * S)).toHaveLength(1);
  });

  it("reads a wall's rows as empty once the column window no longer covers them, which ends it", () => {
    // The window slides up past the wall's rows at 60 s.
    // Rows 112..113 sit inside band 28 (rows 112..115); a pair straddling two bands would be no wall in either.
    const columns = [...series(0, 50, () => WALL), ...series(60, 100, () => ({ bid: { 112: 6, 113: 6 } }), [110, 135])];
    const state = read(columns);
    expect(bidWall(state)).toBeUndefined();
    expect(state.open.get("bid:28")).toMatchObject({ startTs: T + 60 * S });
  });

  it("reads only the deep tier when there is one, so a size means the same at every age", () => {
    const deep = series(0, 100, () => WALL);
    const fine = series(0, 100, () => ({ bid: { 101: 6 } }));
    expect(bidWall(read(fine, { deep }))?.peak).toBe(12);
    expect(bidWall(read(fine))).toBeUndefined();
  });

  it("starts an empty tracker from the oldest column there is", () => {
    const state = read(series(-500, -400, () => WALL));
    expect(bidWall(state)?.startTs).toBe(T - 500 * S);
  });
});

describe("readBands remembers and refills", () => {
  const DIP: Spec = { bid: { 101: 3 } };

  it("counts a refill when the band falls to half its peak and comes back to four fifths, with what came back", () => {
    const state = read(series(0, 300, (s) => (s >= 100 && s <= 150 ? DIP : WALL)));
    expect(bidWall(state)).toMatchObject({ refills: 1, refilled: 9, peak: 12, current: 12 });
  });

  it("counts a comeback short of the old peak, so a wall that keeps being consumed and refilled counts every time", () => {
    // A wall traded into, so it stays through its dips. Peak 40; then 3, back to 14, down to 2, back to 13: two refills,
    // 11 each, though neither returns near 40.
    const at = (s: number, a: number, b: number, c: number, d: number, e: number) => (s < 50 ? a : s < 100 ? b : s < 150 ? c : s < 200 ? d : e);
    const columns = series(0, 300, (s) => merge({ bid: { 101: at(s, 20, 1, 7, 1, 7), 102: at(s, 20, 2, 7, 1, 6) } }, s === 10 ? HIT : {}));
    expect(bidWall(read(columns))).toMatchObject({ refills: 2, refilled: 22, peak: 40, current: 13 });
  });

  it("does not count a shallow dip and return as a refill: the band must have fallen to half its peak", () => {
    const state = read(series(0, 300, (s) => (s >= 100 && s <= 150 ? { bid: { 101: 4, 102: 4 } } : WALL)));
    expect(bidWall(state)).toMatchObject({ refills: 0, refilled: 0, low: 8, current: 12 });
  });

  it("does not count a climb short of both four fifths of the peak and a wall size as a refill", () => {
    // A wall traded into, peak 80. From 3 back to 12 is 9, one short of the wall size of 10, and far from four fifths of 80: no refill.
    const short = read(series(0, 300, (s) => merge(s < 100 ? { bid: { 101: 40, 102: 40 } } : s <= 150 ? DIP : { bid: { 101: 6, 102: 6 } }, s === 10 ? HIT : {})));
    expect(bidWall(short)).toMatchObject({ refills: 0, low: 3, current: 12 });
  });

  it("does not count growth as a refill: a band making new peaks has not come back from anything", () => {
    const state = read(series(0, 300, (s) => ({ bid: { 101: 6 + Math.floor(s / 50), 102: 6 + Math.floor(s / 50) } })));
    expect(bidWall(state)?.refills).toBe(0);
  });

  it("counts a wall as standing from the level's first birth, so a comeback of a known level is drawn at once and a young level still waits", () => {
    const columns = series(0, 600, (s) => (s <= 100 ? WALL : s >= 400 ? WALL : {}));
    const state = read(columns);
    expect(standingWalls(state, T + 400 * S)).toHaveLength(1);
    const young = read(series(0, 100, (s) => (s >= 50 ? WALL : {})));
    expect(standingWalls(young, T + 100 * S)).toHaveLength(0);
  });

  it("ends a wall nothing has traded into when its size leaves: it was pulled", () => {
    const state = read(series(0, 200, (s) => (s <= 100 ? WALL : {})));
    expect(bidWall(state)).toBeUndefined();
    expect(state.memory.get("bid:25")).toMatchObject({ endTs: T + 110 * S, endReason: "pulled" });
  });

  it("keeps a wall that has been traded into however thin it gets: it was consumed, not pulled", () => {
    const columns = series(0, 300, (s) => (s <= 100 ? merge(WALL, s === 50 ? HIT : {}) : {}));
    const state = read(columns);
    expect(bidWall(state)).toMatchObject({ current: 0, peak: 12, eaten: 4, endTs: null });
    expect(standingWalls(state, T + 300 * S)).toHaveLength(1);
  });

  it("ends a wall a bar closes through, under a bid wall or over an ask wall, and not one the close stays on the right side of", () => {
    // The bid wall is rows 100..103. A close on row 100 is not under it; on row 99 it is.
    const state = read(series(0, 100, (s) => merge(WALL, s === 50 ? HIT : {})));
    closeThrough(state, 100, T + 100 * S);
    expect(bidWall(state)).toBeDefined();
    closeThrough(state, 99, T + 100 * S);
    expect(bidWall(state)).toBeUndefined();
    expect(state.memory.get("bid:25")).toMatchObject({ endTs: T + 100 * S, endReason: "closed" });
    const ask = read(series(0, 100, () => ({ ask: { 101: 6, 102: 6 } })));
    closeThrough(ask, 103, T + 100 * S);
    expect(ask.open.get("ask:25")).toBeDefined();
    closeThrough(ask, 104, T + 100 * S);
    expect(ask.open.get("ask:25")).toBeUndefined();
  });

  it("brings a pulled wall back as the same wall when its band is at size again inside the memory span: birth kept, a refill counted, its own life", () => {
    const columns = series(0, 600, (s) => (s <= 100 ? WALL : s >= 400 ? WALL : {}));
    const state = read(columns);
    expect(bidWall(state)).toMatchObject({ startTs: T, resumedTs: T + 400 * S, refills: 1, refilled: 12, crossedTs: null, endTs: null });
    expect(state.memory.size).toBe(0);
    expect(standingWalls(state, T + 400 * S)).toHaveLength(1);
  });

  it("does not come back to a wall closed through: orders there again are a new wall from that moment, and the mitigated one stays remembered", () => {
    // Eight traded into a wall of twelve that stood 200 s, crossed; a bar closes under it; at size again 200 s later.
    const state = read(series(0, 200, (s) => merge(WALL, s === 40 || s === 60 ? HIT : {})));
    closeThrough(state, 99, T + 200 * S);
    read(series(400, 600, () => WALL), { state });
    expect(bidWall(state)).toMatchObject({ startTs: T + 400 * S, resumedTs: T + 400 * S, eaten: 0, peak: 12, refills: 0, refilled: 0, crossedTs: null });
    expect(standingWalls(state, T + 400 * S)).toHaveLength(0);
    expect(standingWalls(state, T + 400 * S + HELD_MS)).toHaveLength(1);
    expect(mitigatedWalls(state)).toHaveLength(1);
    expect(mitigatedWalls(state)[0]).toMatchObject({ startTs: T, endTs: T + 200 * S, endReason: "closed", eaten: 8, crossedTs: T + 60 * S });
  });

  it("lists the mitigated walls that stood their three minutes, and forgets them with the rest after the memory span", () => {
    const state = read(series(0, 100, () => WALL));
    closeThrough(state, 99, T + 100 * S);
    expect(mitigatedWalls(state)).toHaveLength(0);
    const stood = read(series(0, 200, () => WALL));
    closeThrough(stood, 99, T + 200 * S);
    expect(mitigatedWalls(stood)).toHaveLength(1);
    read(series(210, 200 + MEMORY_MS / S + 200, () => ({})), { state: stood, upTo: T + (MEMORY_MS / S + 400) * S });
    expect(mitigatedWalls(stood)).toHaveLength(0);
  });

  it("does not list a pulled wall or one the window left as mitigated", () => {
    const pulled = read(series(0, 300, (s) => (s <= 200 ? WALL : {})));
    expect(pulled.memory.size).toBe(1);
    expect(mitigatedWalls(pulled)).toHaveLength(0);
  });

  it("gives a wall that comes back smaller its own peak, so it is not read against the life before", () => {
    // Two hundred once, pulled; back at ten, the wall floor. Against the old peak ten is a twentieth.
    const columns = series(0, 600, (s) => (s <= 100 ? { bid: { 101: 100, 102: 100 } } : s >= 400 ? { bid: { 101: 5, 102: 5 } } : {}));
    expect(bidWall(read(columns))).toMatchObject({ peak: 10, current: 10, refills: 1, refilled: 10, endTs: null });
  });

  it("starts a new wall when the band comes back after the memory span", () => {
    const back = 100 + MEMORY_MS / S + 20;
    const columns = series(0, back + 100, (s) => (s <= 100 || s >= back ? WALL : {}));
    expect(bidWall(read(columns, { upTo: T + (back + 200) * S }))).toMatchObject({ startTs: T + back * S, refills: 0, refilled: 0 });
  });

  it("resumes a wall the window left behind, or one lost in a long gap, as it was: no refill, its count, peak and crossing kept", () => {
    const away = [...series(0, 100, (s) => merge(WALL, s === 40 || s === 60 ? HIT : {})), ...series(110, 200, () => ({ bid: { 112: 6, 113: 6 } }), [110, 135]), ...series(210, 400, () => WALL)];
    expect(bidWall(read(away))).toMatchObject({ startTs: T, resumedTs: T + 210 * S, refills: 0, eaten: 8, peak: 12, crossedTs: T + 60 * S, endReason: null });
    const gap = series(0, 2000, (s) => merge(WALL, s === 50 ? HIT : {})).filter((c) => c.ts <= T + 100 * S || c.ts >= T + 100 * S + HOLE_MS + STEP);
    expect(bidWall(read(gap, { upTo: T + 2100 * S }))).toMatchObject({ startTs: T, resumedTs: T + 100 * S + HOLE_MS + STEP, refills: 0, eaten: 4 });
  });

  it("forgets an ended wall once the memory span is past", () => {
    const state = read(series(0, 200, (s) => (s <= 100 ? WALL : {})));
    expect(state.memory.size).toBe(1);
    read(series(210, 100 + MEMORY_MS / S + 200, () => ({})), { state, upTo: T + (MEMORY_MS / S + 400) * S });
    expect(state.memory.size).toBe(0);
  });
});

describe("readBands guards a wall strong and traded into", () => {
  const BIG: Spec = { bid: { 101: 50, 102: 50 } };
  /** A quarter of the hundred resting: what the guard asks for. */
  const TOUCH: Spec = { sell: [[101, 25]] };
  const STRONG_RULES: TrackerRules = { ...RULES, strongSize: 100 };

  it("marks a wall guarded the column it has reached the strong size with a quarter traded into it, and never by the hold running out", () => {
    // A hundred resting is the strong size; a quarter sold into it at 50 s guards it there. Fresh, or touched by one, it is not.
    expect(bidWall(read(series(0, 100, (s) => merge(BIG, s === 50 ? TOUCH : {})), { rules: STRONG_RULES }))?.guarded).toBe(true);
    expect(bidWall(read(series(0, 100, () => BIG), { rules: STRONG_RULES }))?.guarded).toBe(false);
    expect(bidWall(read(series(0, 100, (s) => merge(BIG, s === 50 ? { sell: [[101, 24]] } : {})), { rules: STRONG_RULES }))?.guarded).toBe(false);
    // Crossed at 40 s on 8 of 12 and held: strong on the wall size while it stands at it, and not guarded, before the hold runs out or after.
    const columns = series(0, 700, (s) => merge(WALL, s === 20 || s === 40 ? { sell: [[101, 4]] } : {}));
    expect(bidWall(read(columns, { upTo: T + 40 * S + STRONG_HOLD_MS }))?.guarded).toBe(false);
    expect(bidWall(read(columns, { upTo: T + 40 * S + STRONG_HOLD_MS + 1 }))).toMatchObject({ guarded: false, crossedTs: T + 40 * S, current: 12 });
  });

  it("ends a wall that crossed and held, but never reached the strong size, when the window leaves its rows", () => {
    // Crossed at 40 s, held past the ten minutes, then the window moves off band 25: not guarded, so it ends there and is remembered.
    const columns = [...series(0, 700, (s) => merge(WALL, s === 20 || s === 40 ? { sell: [[101, 4]] } : {})), ...series(710, 800, () => ({ bid: { 112: 6, 113: 6 } }), [110, 135])];
    const state = read(columns);
    expect(bidWall(state)).toBeUndefined();
    expect(state.memory.get("bid:25")).toMatchObject({ crossedTs: T + 40 * S, endTs: T + 710 * S, endReason: "window" });
  });

  it("marks a wall at the strong size from what it holds now, keeps the mark to four fifths, and drops it under that", () => {
    // A hundred is the strong size: at 100 marked, at 85 still, at 79 not, and back at 90 not, since it never reached 100 again.
    const at = (s: number) => (s < 30 ? 100 : s < 60 ? 85 : s < 90 ? 79 : 90);
    const columns = series(0, 120, (s) => ({ bid: { 101: at(s) } }));
    expect(bidWall(read(columns, { rules: STRONG_RULES, upTo: T + 25 * S }))?.atStrongSize).toBe(true);
    expect(bidWall(read(columns, { rules: STRONG_RULES, upTo: T + 55 * S }))?.atStrongSize).toBe(true);
    expect(bidWall(read(columns, { rules: STRONG_RULES, upTo: T + 85 * S }))?.atStrongSize).toBe(false);
    expect(bidWall(read(columns, { rules: STRONG_RULES, upTo: T + 125 * S }))?.atStrongSize).toBe(false);
    // Without a size door nothing is ever at size, and one under the size is not at it.
    expect(bidWall(read(columns, { upTo: T + 25 * S }))?.atStrongSize).toBe(false);
    expect(bidWall(read(series(0, 20, () => ({ bid: { 101: 99 } })), { rules: STRONG_RULES }))?.atStrongSize).toBe(false);
  });

  it("does not carry the mark into a comeback: a wall back short of the size is not at it, whatever it was when it left", () => {
    // At 100 and marked; the window leaves its rows; back at 90, over four fifths but never 100 again: not at size, weak.
    const columns = [...series(0, 50, () => BIG), ...series(60, 100, () => ({ bid: { 112: 6, 113: 6 } }), [110, 135]), ...series(110, 200, () => ({ bid: { 101: 90 } }))];
    const wall = bidWall(read(columns, { rules: STRONG_RULES }));
    expect(wall).toMatchObject({ resumedTs: T + 110 * S, current: 90, atStrongSize: false });
  });

  it("keeps the size the wall reached for the life, though the mark of standing at it goes, and starts it fresh on a comeback", () => {
    // Up to 100 -- the strong size -- then down to 30 and left there: no longer at size, but it reached it.
    const columns = series(0, 120, (s) => ({ bid: { 101: s < 30 ? 100 : 30 } }));
    expect(bidWall(read(columns, { rules: STRONG_RULES }))).toMatchObject({ atStrongSize: false, reachedStrongSize: true });
    // Reached the hundred, pulled, and back at fifty: a new life, which has reached nothing, whatever the life before did.
    const pulled = [...series(0, 30, () => ({ bid: { 101: 100 } })), ...series(40, 80, () => ({})), ...series(90, 120, () => ({ bid: { 101: 50 } }))];
    expect(bidWall(read(pulled, { rules: STRONG_RULES }))).toMatchObject({ refills: 1, peak: 50, reachedStrongSize: false });
  });

  it("guards a wall the absorbing has taken under the size, since it reached the size earlier in the life", () => {
    // A hundred is the strong size: the wall stands at 100, then 40 of it is sold into and it is left at 25.
    const columns = series(0, 120, (s) => merge({ bid: { 101: s < 50 ? 100 : 25 } }, s === 50 ? { sell: [[101, 40]] } : {}));
    const wall = bidWall(read(columns, { rules: STRONG_RULES }));
    expect(wall).toMatchObject({ current: 25, peak: 100, eaten: 40, atStrongSize: false, reachedStrongSize: true, guarded: true });
    // Without the size door it never earns the guard: it was never strong.
    expect(bidWall(read(columns))?.guarded).toBe(false);
  });

  it("keeps a guarded wall through the window leaving its rows, at its last read size, where an unguarded one ends", () => {
    const away = [...series(0, 100, (s) => merge(BIG, s === 50 ? TOUCH : {})), ...series(110, 200, () => ({ bid: { 112: 6, 113: 6 } }), [110, 135])];
    const state = read(away, { rules: STRONG_RULES });
    expect(bidWall(state)).toMatchObject({ current: 100, guarded: true, endTs: null });
    expect(standingWalls(state, T + 200 * S)).toHaveLength(1);
    // The same columns with no size door: never strong, so the window ends it.
    expect(bidWall(read(away))).toBeUndefined();
  });

  it("keeps a guarded wall through a gap longer than the hole tolerance, its life unbroken, and ends the rest", () => {
    const columns = series(0, 2000, (s) => merge(BIG, { ask: { 110: 6, 111: 6 } }, s === 50 ? TOUCH : {})).filter((c) => c.ts <= T + 100 * S || c.ts >= T + 100 * S + HOLE_MS + STEP);
    const state = read(columns, { rules: STRONG_RULES, upTo: T + 2100 * S });
    expect(bidWall(state)).toMatchObject({ startTs: T, resumedTs: T, guarded: true, endReason: null });
    // The ask wall on band 27, never traded into, was lost in the gap and came back as itself.
    expect(state.open.get("ask:27")).toMatchObject({ resumedTs: T + 100 * S + HOLE_MS + STEP, guarded: false });
  });

  it("ends a guarded wall only when a bar closes through it, and remembers it mitigated and guarded", () => {
    const state = read(series(0, 100, (s) => merge(BIG, s === 50 ? TOUCH : {})), { rules: STRONG_RULES });
    read(series(110, 300, () => ({})), { state, rules: STRONG_RULES });
    expect(bidWall(state)).toMatchObject({ current: 0, guarded: true, endTs: null });
    closeThrough(state, 99, T + 300 * S);
    expect(bidWall(state)).toBeUndefined();
    expect(mitigatedWalls(state)[0]).toMatchObject({ guarded: true, endReason: "closed" });
  });
});

describe("readBands replays the chart's closes", () => {
  it("ends a wall at the bar that closed through it, however many columns are read in one go", () => {
    // The whole recording read in one pass, as a start-over reads it: the close at 200 s still ends the wall there,
    // and the orders still resting on the band are a new wall from that column, with nothing carried over.
    const columns = series(0, 600, (s) => merge(WALL, s === 50 ? HIT : {}));
    const state = read(columns, { upTo: T + 700 * S, closes: [{ ts: T + 200 * S, row: 99 }] });
    expect(state.memory.get("bid:25")).toMatchObject({ startTs: T, endTs: T + 200 * S, endReason: "closed", eaten: 4 });
    expect(bidWall(state)).toMatchObject({ startTs: T + 200 * S, resumedTs: T + 200 * S, eaten: 0, refills: 0, refilled: 0, crossedTs: null });
  });

  it("applies each close once, in order, and keeps applying them as the read continues", () => {
    const columns = series(0, 600, () => WALL);
    const closes = [{ ts: T + 100 * S, row: 101 }, { ts: T + 400 * S, row: 99 }];
    const state = createBandTracker();
    read(columns, { state, upTo: T + 200 * S, closes });
    expect(bidWall(state)).toMatchObject({ startTs: T });
    read(columns, { state, upTo: T + 700 * S, closes });
    expect(state.memory.get("bid:25")).toMatchObject({ endTs: T + 400 * S, endReason: "closed" });
  });

  it("replays the closes again after a start-over, so a mitigation is not lost with the read", () => {
    // The bug the trader saw: the deep tier lands behind the clock, the read starts over, and walls price had closed
    // through hours before came back alive with their whole cumulative life.
    const deep = series(0, 600, (s) => merge(WALL, s === 50 ? HIT : {}));
    const closes = [{ ts: T + 200 * S, row: 99 }];
    const state = createBandTracker();
    readBands(state, { epoch: 1, deep: null, fine: { columns: series(400, 600, () => WALL), columnMs: STEP } }, T + 700 * S, RULES, undefined, closes);
    readBands(state, { epoch: 1, deep: { columns: deep, columnMs: STEP }, fine: { columns: [], columnMs: STEP } }, T + 700 * S, RULES, undefined, closes);
    expect(state.memory.get("bid:25")).toMatchObject({ endTs: T + 200 * S, endReason: "closed" });
    expect(bidWall(state)).toMatchObject({ startTs: T + 200 * S, eaten: 0 });
  });

  it("does not come back to a level a bar closed through while its wall was already gone: orders there again are a new wall", () => {
    // Pulled at 110 s with nothing traded into it, closed through at 200 s, at size again at 300 s.
    const columns = series(0, 600, (s) => (s <= 100 || s >= 300 ? WALL : {}));
    const state = read(columns, { upTo: T + 700 * S, closes: [{ ts: T + 200 * S, row: 99 }] });
    expect(bidWall(state)).toMatchObject({ startTs: T + 300 * S, resumedTs: T + 300 * S, refills: 0, refilled: 0, eaten: 0 });
    // The pulled wall keeps the end it really had, at 110 s; the close only bars it from coming back.
    expect(state.memory.get("bid:25")).toMatchObject({ startTs: T, endTs: T + 110 * S, endReason: "invalidated" });
    expect(mitigatedWalls(state)).toEqual([]);
  });

  it("keeps a remembered level that the close stayed the right side of", () => {
    const columns = series(0, 600, (s) => (s <= 100 || s >= 300 ? WALL : {}));
    const state = read(columns, { upTo: T + 700 * S, closes: [{ ts: T + 200 * S, row: 101 }] });
    expect(bidWall(state)).toMatchObject({ startTs: T, resumedTs: T + 300 * S, refills: 1 });
  });
});

describe("foldedColumns", () => {
  /** One-second columns from `fromS` to `toS`. */
  function fine(fromS: number, toS: number, spec: (s: number) => Spec, window?: [number, number]): LiquidityColumn[] {
    const out: LiquidityColumn[] = [];
    for (let s = fromS; s <= toS; s += 1) out.push(column(T + s * S, spec(s), window?.[0], window?.[1]));
    return out;
  }
  const feed = (deep: LiquidityColumn[], live: LiquidityColumn[]): ColumnFeed => ({ epoch: 1, deep: { columns: deep, columnMs: STEP }, fine: { columns: live, columnMs: S } });

  it("folds the fine tier past the deep tier's edge into whole windows of the deep tier's width, each row at its most, the flow together", () => {
    // Deep to 100 s; fine from 110 s to 135 s: windows at 110 and 120 are whole, 130 is not yet.
    const live = fine(110, 135, (s) => ({ bid: { 101: s === 115 ? 9 : 6, 102: 6 }, sell: s === 112 || s === 118 ? [[101, 1]] : [] }));
    const folded = foldedColumns(feed(series(0, 100, () => WALL), live), 0, T + 1000 * S);
    expect(folded.map((c) => c.ts)).toEqual([T + 110 * S, T + 120 * S]);
    expect(folded[0].bid[101 - LO]).toBe(9);
    expect(folded[0].bid[102 - LO]).toBe(6);
    expect(folded[0].sell).toEqual([[101, 1], [101, 1]]);
    expect(folded[1].sell).toEqual([]);
  });

  it("folds a window of one-second columns with different levels and medians to one column carrying the largest of each, and a window with none to one carrying none", () => {
    // The heatmap's own fold keeps the same. Window 110 holds levels 3 first, 12 in the middle, 6 last, a 0 and two
    // seconds without one, and medians 2, 5 and 1; window 120 holds a level of 0, a median of 0 and nothing else.
    const levels = new Map([[110, 3], [112, 8], [113, 12], [114, 0], [115, 5], [117, 7], [118, 4], [119, 6], [124, 0]]);
    const medians = new Map([[111, 2], [113, 5], [116, 1], [125, 0]]);
    const live = fine(110, 129, () => WALL).map((column) => {
      const second = (column.ts - T) / S;
      const level = levels.get(second);
      const median = medians.get(second);
      return { ...column, ...(level === undefined ? {} : { reference: level }), ...(median === undefined ? {} : { median }) };
    });
    const folded = foldedColumns(feed(series(0, 100, () => WALL), live), 0, T + 1000 * S);
    expect(folded.map((c) => (c.ts - T) / S)).toEqual([110, 120]);
    expect([folded[0].reference, folded[0].median]).toEqual([12, 5]);
    expect([folded[1].reference, folded[1].median]).toEqual([undefined, undefined]);
  });

  it("takes the union of the windows' rows, a row outside a column's window counting as nothing", () => {
    const live = [...fine(110, 114, () => WALL, [90, 115]), ...fine(115, 119, () => ({ bid: { 112: 6 } }), [100, 130])];
    const [folded] = foldedColumns(feed(series(0, 100, () => WALL), live), 0, T + 1000 * S);
    expect([folded.lo, folded.hi]).toEqual([90, 130]);
    expect([folded.bid[101 - 90], folded.bid[112 - 90]]).toEqual([6, 6]);
  });

  it("starts from where the read stopped and never before the deep tier's edge", () => {
    const live = fine(90, 135, () => WALL);
    const all = foldedColumns(feed(series(0, 100, () => WALL), live), 0, T + 1000 * S);
    expect(all.map((c) => (c.ts - T) / S)).toEqual([110, 120]);
    expect(foldedColumns(feed(series(0, 100, () => WALL), live), T + 111 * S, T + 1000 * S).map((c) => (c.ts - T) / S)).toEqual([120]);
    expect(foldedColumns(feed(series(0, 100, () => WALL), live), 0, T + 115 * S).map((c) => (c.ts - T) / S)).toEqual([110]);
  });

  it("passes the fine tier through when it is already the deep width, the last column included", () => {
    const columns = series(0, 100, () => WALL);
    expect(foldedColumns(feedOf(columns), 0, T + 1000 * S)).toEqual(columns);
  });

  it("reads the deep tier as far as it reaches and the folded fine tier from there, once each", () => {
    const live = fine(110, 145, (s) => merge(WALL, s === 125 ? { sell: [[101, 2]] } : {}));
    const state = createBandTracker();
    readBands(state, feed(series(0, 100, (s) => merge(WALL, s === 50 ? HIT : {})), live), T + 1000 * S, RULES);
    expect(state.lastTs).toBe(T + 130 * S);
    expect(bidWall(state)).toMatchObject({ startTs: T, eaten: 6 });
    readBands(state, feed(series(0, 100, () => WALL), fine(110, 160, () => WALL)), T + 1000 * S, RULES);
    expect(state.lastTs).toBe(T + 150 * S);
    expect(bidWall(state)?.eaten).toBe(6);
  });
});

describe("readBands keeps up with a book that changes behind it", () => {
  const fineOnly = (columns: LiquidityColumn[], epoch = 1): ColumnFeed => ({ epoch, deep: null, fine: { columns, columnMs: STEP } });
  const both = (deep: LiquidityColumn[], fine: LiquidityColumn[], epoch = 1): ColumnFeed => ({ epoch, deep: { columns: deep, columnMs: STEP }, fine: { columns: fine, columnMs: STEP } });

  it("starts over when deep history lands behind its clock, so the wall is born where the book says, not where the tracker first saw it", () => {
    // The live columns come first, from 400 s; the deep tier, from 0 s, arrives after the first read.
    const live = series(400, 600, () => WALL);
    const state = createBandTracker();
    readBands(state, fineOnly(live), T + 700 * S, RULES);
    expect(bidWall(state)).toMatchObject({ startTs: T + 400 * S });
    readBands(state, both(series(0, 390, () => WALL), live), T + 700 * S, RULES);
    expect(bidWall(state)).toMatchObject({ startTs: T, current: 12 });
    expect(state.lastTs).toBe(T + 600 * S);
  });

  it("passes a deep column for a window it already folded from the fine tier: the same wall, its trades counted once", () => {
    const live = series(400, 600, (s) => merge(WALL, s === 500 ? HIT : {}));
    const state = createBandTracker();
    readBands(state, both(series(0, 390, () => WALL), live), T + 700 * S, RULES);
    const wall = bidWall(state);
    expect(wall).toMatchObject({ startTs: T, eaten: 4 });
    // The deep tier catches up through 500 s, the hit included.
    readBands(state, both(series(0, 500, (s) => merge(WALL, s === 500 ? HIT : {})), live), T + 700 * S, RULES);
    expect(bidWall(state)).toBe(wall);
    expect(bidWall(state)).toMatchObject({ eaten: 4, refills: 0 });
    expect(state.deepRead).toEqual({ from: T, to: T + 500 * S, count: 51 });
  });

  it("starts over on a new epoch: the book was rebuilt, and what was read of the old one is not it", () => {
    const state = read(series(0, 600, () => WALL), { upTo: T + 700 * S });
    read(series(0, 200, () => ({})), { state, upTo: T + 700 * S });
    expect(state.memory.size + state.open.size).toBe(1);
    readBands(state, both(series(300, 600, () => WALL), [], 2), T + 700 * S, RULES);
    expect(bidWall(state)).toMatchObject({ startTs: T + 300 * S });
    expect(state.memory.size).toBe(0);
    expect(state.epoch).toBe(2);
  });

  it("starts over when a gap in the deep tier is filled in, so what traded there counts", () => {
    const gapped = series(0, 600, () => WALL).filter((c) => c.ts < T + 200 * S || c.ts > T + 300 * S);
    const state = createBandTracker();
    readBands(state, both(gapped, []), T + 700 * S, RULES);
    expect(bidWall(state)).toMatchObject({ startTs: T, eaten: 0 });
    readBands(state, both(series(0, 600, (s) => merge(WALL, s === 250 ? HIT : {})), []), T + 700 * S, RULES);
    expect(bidWall(state)).toMatchObject({ startTs: T, eaten: 4 });
  });

  it("starts over at most once in the rebuild span, so a book replayed in pieces is read over a few times, not on every piece", () => {
    const state = createBandTracker();
    const at = 1_000_000;
    readBands(state, both(series(300, 600, () => WALL), []), T + 700 * S, RULES, at);
    readBands(state, both(series(200, 600, () => WALL), []), T + 700 * S, RULES, at + 1_000);
    expect(bidWall(state)).toMatchObject({ startTs: T + 200 * S });
    // More history a second later: too soon, the read continues as it was.
    readBands(state, both(series(0, 600, () => WALL), []), T + 700 * S, RULES, at + 2_000);
    expect(bidWall(state)).toMatchObject({ startTs: T + 200 * S });
    // The span up: started over on the whole book.
    readBands(state, both(series(0, 600, () => WALL), []), T + 700 * S, RULES, at + 1_000 + REBUILD_MIN_MS);
    expect(bidWall(state)).toMatchObject({ startTs: T });
  });

  it("starts over when history is added before what it read", () => {
    const state = createBandTracker();
    readBands(state, both(series(300, 600, () => WALL), []), T + 700 * S, RULES);
    expect(bidWall(state)).toMatchObject({ startTs: T + 300 * S });
    readBands(state, both(series(0, 600, () => WALL), []), T + 700 * S, RULES);
    expect(bidWall(state)).toMatchObject({ startTs: T });
  });
});

describe("readBands with the rules' hooks", () => {
  // The absorption engine's walls are the heatmap's: a floor that moves with each column's book, a strong size over it,
  // and a band read the market's way (an index band is its biggest row). The hooks stand in for the fixed sizes, column
  // by column; without them nothing changes for the order-blocks indicator.
  it("opens a wall at the column's own wall size, marks strong at the column's own strong size, and reads a band the hook's way", () => {
    const columns = series(0, 40, (s): Spec => (s < 20 ? { bid: { 101: 6, 102: 6 } } : { bid: { 101: 6, 102: 6, 103: 9 } }));
    const floored: TrackerRules = { ...RULES, wallSize: 1, strongSize: 1, wallSizeAt: (column) => (column.ts < T + 20 * S ? 20 : 12), strongSizeAt: (column) => (column.ts < T + 30 * S ? Infinity : 20) };
    const early = read(columns.slice(0, 2), { rules: floored });
    expect(bidWall(early)).toBeUndefined();
    const opened = read(columns.slice(0, 3), { rules: floored });
    expect(bidWall(opened)).toMatchObject({ startTs: T + 20 * S, peak: 21, reachedStrongSize: false });
    expect(bidWall(read(columns.slice(0, 4), { rules: floored }))).toMatchObject({ reachedStrongSize: true, atStrongSize: true });
    // By the biggest row the same band is 9, under a floor of 12, and never a wall.
    const byRow: TrackerRules = { ...floored, bandSizeOf: (column, side, band) => Math.max(...Array.from({ length: 4 }, (_, i) => column[side][band * 4 + i - column.lo] ?? 0)) };
    expect(bidWall(read(columns, { rules: byRow }))).toBeUndefined();
    expect(bidWall(read(columns, { rules: { ...byRow, wallSizeAt: () => 9 } }))).toMatchObject({ peak: 9, current: 9 });
  });
});
