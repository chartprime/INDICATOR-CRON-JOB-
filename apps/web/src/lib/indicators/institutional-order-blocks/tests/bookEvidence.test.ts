import { describe, expect, it } from "vitest";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import type { ColumnFeed } from "../../absorption-detector/absorptionColumns";
import { HOLE_MS, createZoneRead, readZone, wallTier, type EvidenceRules, type EvidenceZone, type ZoneRead } from "../bookEvidence";

const T = 1_700_000_000_000;
const S = 1_000;
const STEP = 10 * S;
const BAR_MS = 60 * S;
const LO = 90;
const HI = 115;

// Rows are one price wide, so a row is its price. The zone is 100 to 105: rows 100..104. A wall is one row of 10,
// and it keeps while that row holds 5.
const ZONE: EvidenceZone = { side: "bullish", top: 105, bottom: 100, pivotTime: T, baseTime: T + 60 * S, breakTime: T + 240 * S };
const RULES: EvidenceRules = { wall: 10, bandRows: 1, flashMs: 180 * S };
const WINDOW_END = ZONE.breakTime + BAR_MS;

interface Spec {
  bid?: Record<number, number>;
  ask?: Record<number, number>;
  buy?: [row: number, size: number][];
  sell?: [row: number, size: number][];
}

function column(ts: number, spec: Spec = {}): LiquidityColumn {
  const bid = new Float64Array(HI - LO + 1);
  const ask = new Float64Array(HI - LO + 1);
  for (const [row, size] of Object.entries(spec.bid ?? {})) bid[Number(row) - LO] = size;
  for (const [row, size] of Object.entries(spec.ask ?? {})) ask[Number(row) - LO] = size;
  return { ts, lo: LO, hi: HI, bid, ask, buy: spec.buy ?? [], sell: spec.sell ?? [] };
}

/** Columns every STEP from `fromS` to `toS` seconds around T, inclusive. */
function series(fromS: number, toS: number, spec: (s: number) => Spec): LiquidityColumn[] {
  const out: LiquidityColumn[] = [];
  for (let s = fromS; s <= toS; s += STEP / S) out.push(column(T + s * S, spec(s)));
  return out;
}

function feedOf(columns: LiquidityColumn[], deep: LiquidityColumn[] | null = null): ColumnFeed {
  return { epoch: 1, deep: deep ? { columns: deep, columnMs: STEP } : null, fine: { columns, columnMs: STEP } };
}

const WALL: Spec = { bid: { 102: 12 } };
const BUYING: Spec = { buy: [[103, 5]] };
const ATTACK: Spec = { sell: [[102, 6]] };

function merge(...specs: Spec[]): Spec {
  return specs.reduce((a, b) => ({
    bid: { ...a.bid, ...b.bid },
    ask: { ...a.ask, ...b.ask },
    buy: [...(a.buy ?? []), ...(b.buy ?? [])],
    sell: [...(a.sell ?? []), ...(b.sell ?? [])],
  }), {} as Spec);
}

function read(columns: LiquidityColumn[], { zone = ZONE, rules = RULES, deep = null as LiquidityColumn[] | null, upTo = WINDOW_END, state = createZoneRead() } = {}) {
  return { result: readZone(state, { feed: feedOf(columns, deep), rowWidth: 1 }, zone, BAR_MS, upTo, rules), state };
}

function evidenceOf(...args: Parameters<typeof read>) {
  const { result } = read(...args);
  if (result.kind !== "evidence") throw new Error(`expected evidence, got ${result.reason}`);
  return result.evidence;
}

const formed = (spec: (s: number) => Spec = () => WALL) => series(-180, 290, spec);

describe("readZone coverage", () => {
  it("is unverifiable before the reach when there are no columns at all", () => {
    expect(read([]).result).toEqual({ kind: "unverifiable", reason: "before" });
  });

  it("is unverifiable before the reach when the columns begin after the window opens", () => {
    expect(read(series(70, 290, () => WALL)).result).toEqual({ kind: "unverifiable", reason: "before" });
  });

  it("reads through a hole inside the formation window with the columns it has, naming the first hole, and keeps reading after it", () => {
    const columns = formed((s) => merge(WALL, s === 200 ? ATTACK : {})).filter((c) => c.ts <= T + 100 * S || c.ts >= T + 100 * S + HOLE_MS + STEP);
    const { result, state } = read(columns);
    expect(result).toEqual({ kind: "evidence", evidence: { held: true, standing: true, peak: 12, current: 12, hit: 6, delta: -1 }, missing: { from: T + 100 * S, to: T + 100 * S + HOLE_MS + STEP } });
    expect(state.gap).toEqual({ from: T + 100 * S, to: T + 100 * S + HOLE_MS + STEP });
    const second = read([...columns, ...series(300, 400, () => ({}))], { state, upTo: T + 500 * S }).result;
    expect(second).toMatchObject({ kind: "evidence", evidence: { held: true, standing: false, current: 0 } });
    expect(state.gap).toEqual({ from: T + 100 * S, to: T + 100 * S + HOLE_MS + STEP });
    // A second hole inside the window: the first one is the one named.
    const twice = read(columns.filter((c) => c.ts <= T + 180 * S || c.ts >= T + 260 * S));
    expect(twice.result.kind).toBe("evidence");
    expect(twice.state.gap).toEqual({ from: T + 100 * S, to: T + 100 * S + HOLE_MS + STEP });
    // A step under the tolerance is no hole at all.
    const { state: tight } = read(formed().filter((c) => c.ts !== T + 100 * S));
    expect(tight.gap).toBeNull();
  });

  it("does not count a wall across a hole: its age starts again after it, so a wall seen only after it is not yet held", () => {
    // The wall stands 130 s before the hole and 160 s after it: together past the flash age, neither side alone.
    const columns = [...series(-180, -130, () => ({})), ...series(-120, 10, () => WALL), ...series(130, 290, () => WALL)];
    const { result, state } = read(columns);
    expect(result).toEqual({ kind: "evidence", evidence: { held: false, standing: true, peak: 0, current: 12, hit: 0, delta: 0 }, missing: { from: T + 10 * S, to: T + 130 * S } });
    expect(state.gap).toEqual({ from: T + 10 * S, to: T + 130 * S });
  });

  it("with the recording's partial rule, grades from a window the book reaches only part of, and only an empty window stays unread", () => {
    const partial = { ...RULES, partial: true };
    // The book starts two minutes into the window (a recording gap over the swing) and stops a minute and a half short of its end.
    const late = series(120, (WINDOW_END - T) / S - 90, () => WALL);
    expect(read(late).result).toEqual({ kind: "unverifiable", reason: "before" });
    // What the window lacks is named: its start before the book reached it, or its end after the book stopped.
    expect(read(late, { rules: partial }).result).toEqual({ kind: "evidence", evidence: { held: false, standing: true, peak: 0, current: 12, hit: 0, delta: 0 }, missing: { from: T, to: T + 120 * S } });
    const early = series(-180, (WINDOW_END - T) / S - 90, () => WALL);
    expect(read(early).result).toEqual({ kind: "unverifiable", reason: "after" });
    expect(read(early, { rules: partial }).result).toMatchObject({ kind: "evidence", evidence: { held: true, standing: true }, missing: { from: T + 210 * S, to: WINDOW_END } });
    // A window the book reached whole has nothing missing, partial rule or not.
    expect(read(formed(), { rules: partial }).result).toMatchObject({ kind: "evidence", missing: null });
    expect(read(formed()).result).toMatchObject({ kind: "evidence", missing: null });
    // A read cut before the window's end lacks nothing yet: what is not read is not missing.
    expect(read(formed(), { rules: partial, upTo: T + 200 * S }).result).toMatchObject({ kind: "evidence", missing: null });
    expect(read([], { rules: partial }).result).toEqual({ kind: "unverifiable", reason: "before" });
    expect(read(series(-180, -10, () => WALL), { rules: partial }).result).toEqual({ kind: "unverifiable", reason: "before" });
  });

  it("is unverifiable after the reach while the formation window's tail has not printed, and grades once it has", () => {
    const { result, state } = read(series(-180, 200, () => WALL));
    expect(result).toEqual({ kind: "unverifiable", reason: "after" });
    expect(read(formed(), { state }).result.kind).toBe("evidence");
  });

  it("tolerates a tail short of the window's end by less than a hole", () => {
    expect(read(series(-180, (WINDOW_END - T) / S - HOLE_MS / S, () => WALL)).result.kind).toBe("evidence");
  });

  it("is unverifiable on a zone that has no rows", () => {
    expect(read(formed(), { zone: { ...ZONE, top: 100 } }).result).toEqual({ kind: "unverifiable", reason: "rows" });
  });

  it("reads only the deep tier when there is one, so a threshold means the same at every age", () => {
    const deep = formed((s) => merge(WALL, s === 200 ? ATTACK : {}));
    const fine = formed((s) => merge(WALL, s === 210 ? ATTACK : {}));
    expect(evidenceOf(fine, { deep }).hit).toBe(6);
    expect(wallTier(feedOf(fine, deep)).fine.columns).toBe(deep);
    expect(wallTier(feedOf(fine)).fine.columns).toBe(fine);
  });
});

describe("readZone walls", () => {
  it("holds a wall only once it has stood for the flash age, and counts what traded before that all the same", () => {
    const evidence = evidenceOf(formed((s) => (s < 0 ? {} : merge(WALL, BUYING, s === 100 || s === 200 ? ATTACK : {}))));
    expect(evidence.held).toBe(true);
    expect(evidence.hit).toBe(12);
    expect(evidence.peak).toBe(12);
  });

  it("does not hold a flash, though what was thrown at it still counts as traded", () => {
    const evidence = evidenceOf(formed((s) => merge(BUYING, s >= 100 && s <= 150 ? WALL : {}, s === 120 ? ATTACK : {})));
    expect(evidence.held).toBe(false);
    expect(evidence.hit).toBe(6);
    expect(evidence.peak).toBe(0);
  });

  it("counts a wall's age from before the window opened, so one already standing at the swing is held at once", () => {
    expect(evidenceOf(formed((s) => merge(WALL, BUYING, s === 10 ? ATTACK : {}))).hit).toBe(6);
  });

  // The wall comes back bigger after the dip: the peak says whether it was still held when it did.
  it("keeps a wall open while it holds half the threshold, instead of restarting its age on every partial fill", () => {
    expect(evidenceOf(formed((s) => merge(s >= 100 && s <= 150 ? { bid: { 102: 6 } } : s > 150 ? { bid: { 102: 20 } } : WALL, BUYING))).peak).toBe(20);
  });

  it("restarts a wall's age once it falls below half the threshold", () => {
    const evidence = evidenceOf(formed((s) => merge(s >= 100 && s <= 150 ? { bid: { 102: 4 } } : s > 150 ? { bid: { 102: 20 } } : WALL, BUYING)));
    expect(evidence).toMatchObject({ held: true, standing: true, peak: 12 });
  });

  it("reads a wall as one row: a band that sums past the threshold with no single row at it is not a wall", () => {
    const spread: Spec = { bid: { 101: 4, 102: 4, 103: 4 } };
    expect(evidenceOf(formed(() => merge(spread, BUYING))).held).toBe(false);
    expect(evidenceOf(formed(() => merge({ bid: { 101: 1, 102: 10, 103: 1 } }, BUYING))).held).toBe(true);
  });

  it("ignores resting size outside the zone's rows", () => {
    expect(evidenceOf(formed(() => merge({ bid: { 106: 50 } }, BUYING))).held).toBe(false);
  });

  it("reads the asks for a bearish block, and buying as the hit", () => {
    const evidence = evidenceOf(formed((s) => merge({ ask: { 102: 12 } }, s === 200 ? { buy: [[102, 6]] } : {})), { zone: { ...ZONE, side: "bearish" } });
    expect(evidence.held).toBe(true);
    expect(evidence.hit).toBe(6);
    expect(evidence.peak).toBe(12);
  });

  it("says whether the wall is standing at the last column read, so the grade can go down", () => {
    expect(evidenceOf(formed()).standing).toBe(true);
    const gone = evidenceOf(formed((s) => (s >= 260 ? {} : WALL)));
    expect(gone.held).toBe(true);
    expect(gone.standing).toBe(false);
  });
});

describe("readZone bands", () => {
  // The zone is rows 100..104. At four rows a band, the bands touching it are 100..103 and 104..107.
  const BANDS: EvidenceRules = { ...RULES, bandRows: 4 };
  const at = (spec: Spec) => evidenceOf(formed(() => merge(spec, BUYING)), { rules: BANDS });

  it("reads a wall as its band summed, so rows none of which reaches the size make one together", () => {
    const evidence = at({ bid: { 101: 6, 102: 6 } });
    expect([evidence.held, evidence.current, evidence.peak]).toEqual([true, 12, 12]);
  });

  it("starts its bands at multiples of the width, as the heatmap does, so two rows across a band edge do not make a wall", () => {
    const evidence = at({ bid: { 103: 6, 104: 6 } });
    expect([evidence.held, evidence.current]).toEqual([false, 6]);
  });

  it("starts its bands at multiples of the width even when the zone does not, so the card matches the ledger's cluster", () => {
    // The zone is rows 102..104: a band anchored to the zone would read 102..105 and make a wall of these two rows.
    const evidence = evidenceOf(formed(() => merge({ bid: { 103: 6, 104: 6 } }, BUYING)), { rules: BANDS, zone: { ...ZONE, bottom: 102 } });
    expect([evidence.held, evidence.current]).toEqual([false, 6]);
  });

  it("takes the biggest band touching the zone, counting that band's rows past the zone's edge as the ledger does", () => {
    expect(at({ bid: { 101: 6, 102: 6, 104: 5, 106: 10 } }).current).toBe(15);
  });

  it("reads one row at a width of one, as before", () => {
    expect(evidenceOf(formed(() => merge({ bid: { 101: 6, 102: 6 } }, BUYING))).held).toBe(false);
  });

  // A band-history answer holds exactly the zone's rows, so its first and last bands cross the column's edge.
  const clipped = (columns: LiquidityColumn[]) => columns.map((c) => ({
    ...c, lo: 100, hi: 104, bid: c.bid.slice(100 - LO, 105 - LO), ask: c.ask.slice(100 - LO, 105 - LO),
  }));

  it("reads a band crossing a live or band-history column's edge over the rows the column holds", () => {
    const evidence = evidenceOf(clipped(formed(() => merge({ bid: { 101: 6, 102: 6 } }, BUYING))), { rules: BANDS });
    expect([evidence.held, evidence.current]).toEqual([true, 12]);
  });

  it("calls a band crossing a historical column's edge unobserved: past it the source saw no depth", () => {
    const { result } = read(clipped(formed(() => merge({ bid: { 101: 6, 102: 6 } }, BUYING))), { rules: { ...BANDS, edgeUnknown: true } });
    expect(result).toMatchObject({ kind: "unverifiable", reason: "hole" });
  });

  it("calls a band with an unobserved row inside the column unobserved, in either mode", () => {
    const columns = formed(() => merge({ bid: { 101: 6, 102: 6 } }, BUYING)).map((c) => {
      const bid = c.bid.slice();
      bid[103 - LO] = NaN;
      return { ...c, bid };
    });
    expect(read(columns, { rules: BANDS }).result).toMatchObject({ kind: "unverifiable", reason: "hole" });
    expect(read(columns, { rules: { ...BANDS, edgeUnknown: true } }).result).toMatchObject({ kind: "unverifiable", reason: "hole" });
  });
});

describe("readZone hits", () => {
  it("counts only the opposing side as a hit", () => {
    expect(evidenceOf(formed((s) => merge(WALL, BUYING, s === 200 ? { buy: [[102, 6]] } : {}))).hit).toBe(0);
  });

  it("counts nothing from before the swing: the lookback is for the wall's age only", () => {
    expect(evidenceOf(formed((s) => merge(WALL, BUYING, s === -50 ? ATTACK : {}))).hit).toBe(0);
  });

  it("ignores flow into rows outside the zone", () => {
    expect(evidenceOf(formed((s) => merge(WALL, BUYING, s === 200 ? { sell: [[106, 6]] } : {}))).hit).toBe(0);
  });

  it("counts a hit in a row the zone only half covers, and not one in the row it merely touches", () => {
    const hit: Spec = { sell: [[104, 6]] };
    expect(evidenceOf(formed((s) => merge(WALL, BUYING, s === 200 ? hit : {})), { zone: { ...ZONE, top: 104.5 } }).hit).toBe(6);
    expect(evidenceOf(formed((s) => merge(WALL, BUYING, s === 200 ? hit : {})), { zone: { ...ZONE, top: 104 } }).hit).toBe(0);
  });
});

describe("readZone delta", () => {
  it("reads the leg from the base bar to the break, signed in the block's direction", () => {
    const columns = formed((s) => merge(WALL, s >= 60 ? BUYING : {}));
    expect(evidenceOf(columns).delta).toBeCloseTo(1, 6);
    expect(evidenceOf(columns, { zone: { ...ZONE, side: "bearish" } }).delta).toBeCloseTo(-1, 6);
  });

  it("leaves the decline into the base out of the leg", () => {
    expect(evidenceOf(formed((s) => merge(WALL, s >= 0 && s < 60 ? { sell: [[101, 50]] } : BUYING))).delta).toBeCloseTo(1, 6);
  });

  it("stops the leg at the break, so what trades later does not move it", () => {
    const columns = series(-180, 500, (s) => merge(WALL, s >= 60 && s < 300 ? BUYING : s >= 300 ? { sell: [[101, 50]] } : {}));
    expect(evidenceOf(columns, { upTo: T + 600 * S }).delta).toBeCloseTo(1, 6);
  });

  it("is zero over a leg with no flow rather than a division by nothing", () => {
    expect(evidenceOf(formed()).delta).toBe(0);
  });
});

describe("readZone continues", () => {
  const LIVE = series(-180, 600, (s) => merge(s < 500 ? WALL : {}, s >= 60 && s < 300 ? BUYING : {}, s === 200 || s === 400 ? ATTACK : {}));

  it("reads in pieces to the same answer as in one go", () => {
    const whole = evidenceOf(LIVE, { upTo: T + 700 * S });
    const state: ZoneRead = createZoneRead();
    for (const upTo of [T + 100 * S, T + 250 * S, T + 450 * S, T + 700 * S]) read(LIVE, { state, upTo });
    expect(read(LIVE, { state, upTo: T + 700 * S }).result).toEqual({ kind: "evidence", evidence: whole, missing: null });
    // The hit at 200 s is inside the formation window and a sell inside the leg: 24 columns of 5 bought against 6 sold.
    // The hit at 400 s came after the break and counts the same: traded is the zone's whole life.
    expect(whole).toMatchObject({ held: true, standing: false, peak: 12, current: 0, hit: 12 });
    expect(whole.delta).toBeCloseTo(114 / 126, 6);
  });

  it("keeps counting traded after the break, while keeping the wall's size live and seeing it leave", () => {
    const state = createZoneRead();
    expect(evidenceOf(LIVE, { state, upTo: T + 300 * S })).toMatchObject({ standing: true, current: 12, hit: 6 });
    expect(evidenceOf(LIVE, { state, upTo: T + 450 * S })).toMatchObject({ standing: true, current: 12, hit: 12 });
    expect(evidenceOf(LIVE, { state, upTo: T + 700 * S })).toMatchObject({ standing: false, current: 0, hit: 12 });
  });

  it("counts what trades into the zone whether or not a wall stands there at the time", () => {
    const gone = series(-180, 600, (s) => merge(s < 350 ? WALL : {}, s === 200 || s === 400 ? ATTACK : {}));
    expect(evidenceOf(gone, { upTo: T + 700 * S })).toMatchObject({ hit: 12, standing: false });
    const never = series(-180, 600, (s) => (s === 200 || s === 400 ? ATTACK : {}));
    expect(evidenceOf(never, { upTo: T + 700 * S })).toMatchObject({ held: false, hit: 12 });
  });

  it("reports the wall as it stands now, not at its largest, once it has been eaten down but still holds", () => {
    const columns = series(-180, 400, (s) => merge(s >= 300 ? { bid: { 102: 7 } } : WALL, BUYING));
    const state = createZoneRead();
    read(columns, { state });
    expect(evidenceOf(columns, { state, upTo: T + 500 * S })).toMatchObject({ standing: true, peak: 12, current: 7 });
  });

  it("treats a hole after the formation window as the wall closing, not as the zone unreadable", () => {
    const columns = [...formed(), ...series(400, 500, () => ({}))];
    const state = createZoneRead();
    expect(evidenceOf(columns, { state })).toMatchObject({ standing: true });
    const later = read(columns, { state, upTo: T + 600 * S }).result;
    expect(state.gap).toBeNull();
    expect(later.kind).toBe("evidence");
    expect(later.kind === "evidence" && later.evidence).toMatchObject({ held: true, standing: false });
  });

  it("restarts a wall's age at a gap, so one standing bigger right after is not yet held and does not raise the peak", () => {
    const columns = [...formed(), ...series(400, 450, () => ({ bid: { 102: 20 } }))];
    const state = createZoneRead();
    read(columns, { state });
    expect(evidenceOf(columns, { state, upTo: T + 600 * S })).toMatchObject({ held: true, standing: true, peak: 12, current: 20 });
  });

  it("does not read the same column twice", () => {
    const state = createZoneRead();
    read(LIVE, { state, upTo: T + 300 * S });
    expect(evidenceOf(LIVE, { state, upTo: T + 300 * S }).hit).toBe(6);
  });

  it("counts each second once when the deep tier arrives after a zone was first read on fine columns", () => {
    // A runtime started without stored liquidity sends one-second columns first; the first ten-second deep column
    // lands only once its window closes. The server stamps a deep column with its window's start and folds the fine
    // columns of [start, start + 10 s) into it. Every fine second sells 1 into the zone.
    const fine: LiquidityColumn[] = [];
    for (let s = -180; s <= 300; s += 1) fine.push(column(T + s * S, merge(WALL, { sell: [[102, 1]] })));
    const deep: LiquidityColumn[] = [];
    for (let s = -180; s <= 300; s += 10) deep.push(column(T + s * S, merge(WALL, { sell: [[102, Math.min(10, 301 - s)]] })));
    const book = (withDeep: boolean) => ({
      feed: { epoch: 1, deep: withDeep ? { columns: deep, columnMs: STEP } : null, fine: { columns: fine, columnMs: S } },
      rowWidth: 1,
    });
    const state = createZoneRead();
    readZone(state, book(false), ZONE, BAR_MS, T + 15 * S + 1, RULES);
    expect(state.hit).toBe(16);
    const result = readZone(state, book(true), ZONE, BAR_MS, T + 301 * S, RULES);
    expect(result.kind).toBe("evidence");
    expect(state.hit).toBe(301);
    // A read that stops inside the deep window still being finished stays on the fine columns until it is done.
    const paused = createZoneRead();
    readZone(paused, book(false), ZONE, BAR_MS, T + 15 * S + 1, RULES);
    readZone(paused, book(true), ZONE, BAR_MS, T + 18 * S + 1, RULES);
    expect(paused.hit).toBe(19);
    readZone(paused, book(true), ZONE, BAR_MS, T + 301 * S, RULES);
    expect(paused.hit).toBe(301);
  });
});
