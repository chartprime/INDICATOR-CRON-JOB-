import { describe, expect, it } from "vitest";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import { LIGHT_SHARE, MIN_MOVE_WINDOWS, MIN_RANK_PUSHES, MIN_RECOMPUTE_MS, MOVE_WINDOWS, RANK_PUSHES, SLOT_MS, VOLUME_MEMORY_MS, WAIT_WINDOWS, createLearned, judge, learnedHasEnough, learnedReady, minMoveRowsOf, settleSpanMs, stepLearned, windowMsFor, type LearnedState } from "../learnedThresholds";
import { createSweepState, liveSweeps, type PushVerdict, type SweepBox, type SweepState } from "../sweepModel";

const T = 1_700_000_000_000 - (1_700_000_000_000 % 3_600_000);
const ROW = 4;
const BASE_ROW = 1_000;
const HIGH = 1;
const NORMAL = 1.25;
const LOW = 1.5;
const MINUTE = 60_000;

type Flow = [number, number][];

/** A 10-s column with the book at `row`, printing 5 bought and 5 sold well below it: one unit a second, in no push's rows. */
function col(ts: number, row: number): LiquidityColumn {
  const lo = row - 40;
  const hi = row + 41;
  const bid = new Float64Array(hi - lo + 1);
  const ask = new Float64Array(hi - lo + 1);
  bid[row - lo] = 5;
  ask[row + 1 - lo] = 5;
  return { ts, lo, hi, bid, ask, buy: [[row - 20, 5]], sell: [[row - 20, 5]] };
}

/** Columns in time order; a jump's trades print on the column before it, in the rows it crosses. */
class Tape {
  columns: LiquidityColumn[] = [];
  ts = T;
  row = BASE_ROW;
  blind = false;

  hold(slots: number): this {
    for (let i = 0; i < slots; i += 1) this.push(col(this.ts, this.row));
    return this;
  }

  jump(rows: number, volume: number | null = null): this {
    const previous = this.columns[this.columns.length - 1];
    if (previous !== undefined && volume !== null && !this.blind) {
      const crossed: Flow = [];
      const count = Math.abs(rows);
      for (let i = 1; i <= count; i += 1) crossed.push([rows > 0 ? this.row + i : this.row - i + 1, volume / count]);
      if (rows > 0) previous.buy = [...(previous.buy ?? []), ...crossed];
      else previous.sell = [...(previous.sell ?? []), ...crossed];
    }
    this.row += rows;
    this.push(col(this.ts, this.row));
    return this;
  }

  /** One window of background: a one-row jump, up or down in turn, then two holds; every tenth window the jump is `bigRows`. */
  background(windows: number, bigRows = 4): this {
    for (let i = 0; i < windows; i += 1) {
      const direction = i % 2 === 0 ? 1 : -1;
      this.jump(direction * (i % 10 === 9 ? bigRows : 1), 10);
      this.hold(2);
    }
    return this;
  }

  gap(ms: number): this {
    this.ts += ms;
    return this;
  }

  /** Columns with no book at all, so no price, and nothing printed. */
  blank(slots: number): this {
    for (let i = 0; i < slots; i += 1) {
      const empty = col(this.ts, this.row);
      empty.bid = new Float64Array(empty.bid.length);
      empty.ask = new Float64Array(empty.ask.length);
      empty.buy = [];
      empty.sell = [];
      this.push(empty);
    }
    return this;
  }

  private push(column: LiquidityColumn): void {
    if (this.blind) {
      delete column.buy;
      delete column.sell;
    }
    this.columns.push(column);
    this.ts += SLOT_MS;
  }
}

interface Run {
  learned: LearnedState;
  sweep: SweepState;
  verdicts: PushVerdict[];
}

function run(columns: readonly LiquidityColumn[], k: number, windowMs = 30_000, rowWidth = ROW, columnMs = SLOT_MS): Run {
  const learned = createLearned(windowMs);
  const sweep = createSweepState(rowWidth);
  const verdicts: PushVerdict[] = [];
  for (const column of columns) {
    const verdict = stepLearned(learned, sweep, column, columnMs, k);
    if (verdict !== null) verdicts.push(verdict);
  }
  return { learned, sweep, verdicts };
}

/** The columns of a 10-s tape as 1-s columns: the book held through the ten seconds, the prints on the first. */
function fine(columns: readonly LiquidityColumn[]): LiquidityColumn[] {
  const out: LiquidityColumn[] = [];
  for (const column of columns) {
    for (let i = 0; i < 10; i += 1) {
      const copy: LiquidityColumn = { ts: column.ts + i * 1_000, lo: column.lo, hi: column.hi, bid: column.bid, ask: column.ask };
      if (column.buy !== undefined) copy.buy = i === 0 ? column.buy : [];
      if (column.sell !== undefined) copy.sell = i === 0 ? column.sell : [];
      out.push(copy);
    }
  }
  return out;
}

function scaled(columns: readonly LiquidityColumn[], volume: number): LiquidityColumn[] {
  return columns.map((column) => ({ ...column, buy: column.buy?.map(([row, size]) => [row, size * volume] as const), sell: column.sell?.map(([row, size]) => [row, size * volume] as const) }));
}

/** Drops the background prints from every slot but one in `every`, keeping the prints of the jumps: a thin market. */
function thinned(columns: readonly LiquidityColumn[], every: number): LiquidityColumn[] {
  return columns.map((column, index) => (index % every === 0 ? column : { ...column, buy: column.buy?.slice(1), sell: column.sell?.slice(1) }));
}

interface Snapshot {
  ts: number;
  steady: boolean;
  open: boolean;
  priced: boolean;
  syncId: number;
}

/** Steps a run column by column, noting after each one whether the memories are steady, a push is open and the column has a price. */
function snapshots(columns: readonly LiquidityColumn[], windowMs = 30_000): { snaps: Snapshot[]; out: Run } {
  const out: Run = { learned: createLearned(windowMs), sweep: createSweepState(ROW), verdicts: [] };
  const snaps: Snapshot[] = [];
  for (const column of columns) {
    const verdict = stepLearned(out.learned, out.sweep, column, SLOT_MS, HIGH);
    if (verdict !== null) out.verdicts.push(verdict);
    snaps.push({ ts: column.ts, steady: out.learned.steady, open: out.sweep.open !== null, priced: column.bid.some((size) => size > 0) || column.ask.some((size) => size > 0), syncId: out.learned.syncId });
  }
  return { snaps, out };
}

/** The first column at which both memories are full, and the first at which the run calls itself steady. */
function memoryTimes(columns: readonly LiquidityColumn[], windowMs: number): { full: number; steady: number } {
  const learned = createLearned(windowMs);
  const sweep = createSweepState(ROW);
  let full = Number.NaN;
  let steady = Number.NaN;
  for (const column of columns) {
    stepLearned(learned, sweep, column, SLOT_MS, HIGH);
    if (Number.isNaN(full) && learned.moves.count === learned.moves.values.length && learned.traded.count === learned.traded.values.length) full = column.ts;
    if (Number.isNaN(steady) && learned.steady) steady = column.ts;
  }
  return { full, steady };
}

/** Seventy heavier pushes, then a hundred and sixty lighter ones of varied volume and spacing. */
function regimes(): { tape: Tape; secondFrom: number } {
  const tape = new Tape().background(25, 1);
  for (let i = 0; i < 70; i += 1) tape.jump(i % 2 === 0 ? 5 : -5, 120 + ((i * 37) % 180)).hold(5);
  const secondFrom = tape.ts;
  tape.background(5, 1);
  for (let i = 0; i < 160; i += 1) tape.jump(i % 2 === 0 ? 5 : -5, 15 + ((i * 53) % 170)).hold(5 + (i % 3));
  return { tape, secondFrom };
}

function boxKey(box: SweepBox): string {
  return [box.side, box.rowLo, box.rowHi, box.startTs, box.endTs, box.volume].join(":");
}

describe("learned thresholds", () => {
  it("measures a push over a window that grows with the chart: 30 s on 1m, 90 s on 5m, 3 min on 15m, 8 min on 1h, 20 min on 4h, 70 min on 1D, and 30 s x minutes^0.68 to the 10 s column in between", () => {
    expect([1, 5, 15, 60, 240, 1_440].map((minutes) => windowMsFor(minutes * MINUTE) / 1_000)).toEqual([30, 90, 180, 480, 1_200, 4_200]);
    expect([2, 3, 30, 360, 720].map((minutes) => windowMsFor(minutes * MINUTE) / 1_000)).toEqual([50, 60, 300, 1_640, 2_630]);
  });

  it("learns the usual fast move as the 90th percentile of the market's own moves over the last 60 windows, and boxes a push of Sensitivity times it: 4 rows on High, 5 on Normal, 6 on Low, never one row under", () => {
    const usual = run(new Tape().background(40).hold(1).columns, NORMAL).learned.usual;
    expect(usual).toBeGreaterThan(39);
    expect(usual).toBeLessThan(41);
    for (const [k, rows] of [[HIGH, 4], [NORMAL, 5], [LOW, 6]] as const) {
      const boxed = run(new Tape().background(40).jump(rows, 10).columns, k).sweep;
      expect(liveSweeps(boxed).map((box) => box.rowHi - box.rowLo + 1)).toEqual([rows]);
      const under = run(new Tape().background(40).jump(rows - 1, 10).columns, k).sweep;
      expect(liveSweeps(under).filter((box) => box.rowHi - box.rowLo + 1 === rows - 1)).toHaveLength(0);
    }
  });

  it("judges nothing until the market has 30 windows of moves to learn from", () => {
    const short = new Tape().background(MIN_MOVE_WINDOWS - 2).jump(6, 10).hold(3);
    const early = run(short.columns, NORMAL);
    expect(learnedReady(early.learned)).toBe(false);
    expect(early.sweep.boxes).toHaveLength(0);
    const enough = new Tape().background(MIN_MOVE_WINDOWS + 2).jump(6, 10).hold(3);
    const ready = run(enough.columns, NORMAL);
    expect(learnedReady(ready.learned)).toBe(true);
    expect(ready.sweep.boxes.length + ready.verdicts.length).toBeGreaterThan(0);
  });

  it("counts its memories in trading data: after a hole of more than ten minutes it keeps what it learned, waits three windows of fresh data, then judges again", () => {
    const tape = new Tape().background(40).gap(11 * MINUTE);
    const gapAt = tape.ts;
    tape.hold(4).jump(6, 10);
    const blocked = run(tape.columns, NORMAL);
    expect(blocked.learned.usual).toBeGreaterThan(39);
    expect(learnedReady(blocked.learned)).toBe(false);
    expect(blocked.sweep.boxes.filter((box) => box.startTs >= gapAt)).toHaveLength(0);
    const waited = new Tape().background(40).gap(11 * MINUTE).hold(WAIT_WINDOWS * 3 + 1).jump(6, 10);
    const resumed = run(waited.columns, NORMAL);
    expect(learnedReady(resumed.learned)).toBe(true);
    expect(resumed.sweep.boxes.filter((box) => box.startTs >= gapAt).map((box) => box.rowHi - box.rowLo + 1)).toEqual([6]);
    const shortHole = new Tape().background(40).gap(5 * MINUTE);
    const holeAt = shortHole.ts;
    const unbroken = run(shortHole.hold(4).jump(6, 10).columns, NORMAL);
    expect(unbroken.sweep.boxes.filter((box) => box.startTs >= holeAt).map((box) => box.rowHi - box.rowLo + 1)).toEqual([6]);
  });

  it("ranks a push by its volume against what normally trades in that time, among the last 60 pushes: the lightest 25 % are kept, the first 8 pushes are only learned from, and unknown volume is never ranked", () => {
    const tape = new Tape().background(40, 1);
    for (let i = 1; i <= 2 * MIN_RANK_PUSHES; i += 1) tape.jump(i % 2 === 1 ? 5 : -5, 30 * i).hold(5);
    const learnt = run(tape.columns, HIGH);
    expect(learnt.verdicts.slice(0, MIN_RANK_PUSHES)).toEqual(Array.from({ length: MIN_RANK_PUSHES }, () => "early"));
    expect(learnt.verdicts.slice(MIN_RANK_PUSHES).every((verdict) => verdict === "light" || verdict === "heavy")).toBe(true);
    expect(LIGHT_SHARE).toBe(0.25);
    const judged = (volume: number | null): Run => {
      const own = new Tape().background(40, 1);
      for (let i = 1; i <= MIN_RANK_PUSHES; i += 1) own.jump(i % 2 === 1 ? 5 : -5, 30 * i).hold(5);
      own.blind = volume === null;
      own.hold(2).jump(5, volume ?? 0).hold(5);
      return run(own.columns, HIGH);
    };
    expect(judged(90).verdicts[MIN_RANK_PUSHES]).toBe("light");
    expect(judged(120).verdicts[MIN_RANK_PUSHES]).toBe("heavy");
    expect(judged(null).verdicts[MIN_RANK_PUSHES]).toBe("unknown");
    expect(liveSweeps(judged(90).sweep).map((box) => box.verdict)).toEqual(["light"]);
    expect(liveSweeps(judged(120).sweep)).toHaveLength(0);
    expect(liveSweeps(judged(null).sweep)).toHaveLength(0);
  });

  it("forgets the 61st push back: once the lighter pushes have left the memory, the same push reads as light", () => {
    const small = 16;
    const tape = new Tape().background(40, 1);
    for (let i = 0; i < small; i += 1) tape.jump(i % 2 === 0 ? 5 : -5, 30).hold(5);
    for (let i = 0; i < RANK_PUSHES - small; i += 1) tape.jump(i % 2 === 0 ? 5 : -5, 300).hold(5);
    tape.jump(5, 150).hold(5);
    const full = run(tape.columns, HIGH).verdicts;
    expect(full[RANK_PUSHES]).toBe("heavy");
    const aged = new Tape().background(40, 1);
    for (let i = 0; i < small; i += 1) aged.jump(i % 2 === 0 ? 5 : -5, 30).hold(5);
    for (let i = 0; i < RANK_PUSHES - small + 2; i += 1) aged.jump(i % 2 === 0 ? 5 : -5, 300).hold(5);
    aged.jump(5, 150).hold(5);
    expect(run(aged.columns, HIGH).verdicts[RANK_PUSHES + 2]).toBe("light");
  });

  it("gives the same verdicts from 1 s columns as from 10 s columns, since moves are sampled every 10 s and volume is compared per second", () => {
    const tape = new Tape().background(40, 1);
    for (let i = 1; i <= 12; i += 1) tape.jump(i % 2 === 1 ? 5 : -5, 20 * (i % 4) + 20).hold(5);
    const coarse = run(tape.columns, HIGH);
    const fineRun = run(fine(tape.columns), HIGH, 30_000, ROW, 1_000);
    expect(coarse.verdicts).toHaveLength(12);
    expect(fineRun.verdicts).toEqual(coarse.verdicts);
    expect(liveSweeps(fineRun.sweep).map((box) => [box.rowLo, box.rowHi, box.startTs])).toEqual(liveSweeps(coarse.sweep).map((box) => [box.rowLo, box.rowHi, box.startTs]));
  });

  it("gives the same verdicts to two markets of very different price and volume with the same shape of trading", () => {
    const tape = new Tape().background(40, 1);
    for (let i = 1; i <= 12; i += 1) tape.jump(i % 2 === 1 ? 5 : -5, 20 * (i % 4) + 20).hold(5);
    const crypto = run(tape.columns, HIGH);
    const stock = run(scaled(tape.columns, 1_000), HIGH, 30_000, ROW / 100);
    expect(stock.verdicts).toEqual(crypto.verdicts);
    expect(crypto.learned.perSecond).toBeCloseTo(1, 6);
    expect(stock.learned.perSecond).toBeCloseTo(1_000, 6);
  });

  it("scores a push as its volume over what the market normally trades in that long: a slower push of the same volume scores lower, a busier market makes the same push lighter", () => {
    const box = (volume: number, seconds: number): SweepBox => ({ id: 0, side: "ask", rowLo: 1, rowHi: 5, startTs: T, endTs: T + seconds * 1_000, volume, open: false, endedAt: null, endedBy: null, verdict: null });
    const learned = createLearned(30_000);
    learned.perSecond = 1;
    for (let i = 0; i < MIN_RANK_PUSHES; i += 1) expect(judge(learned, box(45, 30))).toBe("early");
    expect(judge(learned, box(60, 60))).toBe("light");
    expect(judge(learned, box(60, 30))).toBe("heavy");
    learned.perSecond = 10;
    expect(judge(learned, box(150, 30))).toBe("light");
  });

  it("takes the normal volume from the last thirty minutes of trading on every timeframe, so a session's pace replaces the last one's within half an hour", () => {
    const busy = new Tape().background(40);
    for (const column of busy.columns) {
      column.buy = [[BASE_ROW - 20, 50]];
      column.sell = [[BASE_ROW - 20, 50]];
    }
    const quietFrom = busy.ts;
    busy.hold(120);
    const learned = run(busy.columns, HIGH, 480_000).learned;
    expect(learned.perSecond).toBe(1);
    const stillBusy = run(busy.columns.filter((column) => column.ts < quietFrom + 90 * SLOT_MS), HIGH, 480_000).learned;
    expect(stillBusy.perSecond).toBe(10);
  });

  it("guards its memories: a slot without known flow adds no volume sample, the normal volume waits for sixty samples, a push is scored only once and only with a known normal volume, the learned minimum never goes under two rows, and a timeframe without minutes falls back to the 30 s window", () => {
    expect([windowMsFor(0), windowMsFor(-5)]).toEqual([30_000, 30_000]);
    expect(run(new Tape().hold(60).columns, HIGH).learned.perSecond).toBeNaN();
    expect(run(new Tape().hold(61).columns, HIGH).learned.perSecond).toBe(1);
    const blind = new Tape().background(40);
    blind.blind = true;
    blind.hold(130);
    expect(run(blind.columns, HIGH).learned.perSecond).toBe(1);
    const fresh = createLearned(30_000);
    expect(judge(fresh, { id: 0, side: "ask", rowLo: 1, rowHi: 5, startTs: T, endTs: T + 30_000, volume: 10, open: false, endedAt: null, endedBy: null, verdict: null })).toBe("early");
    expect(fresh.scores.count).toBe(0);
    const once = new Tape().background(40, 1);
    for (let i = 1; i <= MIN_RANK_PUSHES; i += 1) once.jump(i % 2 === 1 ? 5 : -5, 30 * i).hold(5);
    once.jump(5, 30).hold(5);
    const lastLight = run(once.columns, HIGH);
    expect(liveSweeps(lastLight.sweep).map((box) => box.verdict)).toEqual(["light"]);
    once.hold(30);
    expect(run(once.columns, HIGH).learned.scores.count).toBe(lastLight.learned.scores.count);
    const floor = createLearned(30_000);
    floor.usual = 0.01;
    floor.sinceGap = 1_000;
    expect(minMoveRowsOf(floor, 1, 4_000, 4)).toBe(2);
    const enough = createLearned(30_000);
    enough.usual = 10;
    enough.perSecond = 1;
    for (let i = 0; i < MIN_RANK_PUSHES; i += 1) judge(enough, { id: i, side: "ask", rowLo: 1, rowHi: 5, startTs: T, endTs: T + 30_000, volume: 10, open: false, endedAt: null, endedBy: null, verdict: null });
    expect(learnedHasEnough(enough)).toBe(true);
    expect(learnedHasEnough({ ...enough, usual: NaN })).toBe(false);
    expect(learnedHasEnough({ ...enough, perSecond: NaN })).toBe(false);
    expect(learnedHasEnough({ ...enough, scores: { ...enough.scores, count: MIN_RANK_PUSHES - 1 } })).toBe(false);
  });

  it("ignores a column older than the last one, like the detector", () => {
    const tape = new Tape().background(40, 1);
    const columns = [...tape.columns, col(tape.ts - 50 * SLOT_MS, BASE_ROW + 40)];
    const out = run(columns, NORMAL);
    expect(out.sweep.boxes).toHaveLength(0);
    expect(out.learned.lastTs).toBe(tape.ts - SLOT_MS);
  });

  it("keeps a normal volume on a thin market: when most 10-s slots trade nothing it takes the mean per second instead of a median of zero, so pushes are still judged; a market with no trade at all still waits (#46 review)", () => {
    const tape = new Tape();
    for (let i = 0; i < 40; i += 1) tape.jump(i % 2 === 0 ? 1 : -1).hold(2);
    for (let i = 1; i <= MIN_RANK_PUSHES + 4; i += 1) tape.jump(i % 2 === 1 ? 5 : -5, 30 * i).hold(5);
    tape.jump(5, 30).hold(5);
    const columns = thinned(tape.columns, 3);
    const atRecompute = run(columns.slice(0, columns.map((column) => column.ts % MIN_RECOMPUTE_MS === 0).lastIndexOf(true) + 1), HIGH).learned;
    const traded = [...atRecompute.traded.values].sort((a, b) => a - b);
    expect(traded[Math.floor(traded.length / 2)]).toBe(0);
    expect(atRecompute.perSecond).toBeCloseTo(traded.reduce((sum, value) => sum + value, 0) / traded.length, 9);
    const thin = run(columns, HIGH);
    expect(thin.learned.perSecond).toBeGreaterThan(0);
    expect(learnedHasEnough(thin.learned)).toBe(true);
    expect(thin.verdicts.slice(MIN_RANK_PUSHES)).toEqual(["heavy", "heavy", "heavy", "heavy", "light"]);
    const silent = run(thinned(new Tape().hold(200).columns, Number.POSITIVE_INFINITY), HIGH);
    expect(silent.learned.perSecond).toBe(0);
    expect(learnedHasEnough(silent.learned)).toBe(false);
  });

  it("recomputes its learned numbers on the clock, every max(60 s, window/2) counted from the epoch, so two runs over the same columns recompute together whatever column they started on (#46 review)", () => {
    const tape = new Tape();
    for (let i = 0; i < 120; i += 1) tape.jump((i % 2 === 0 ? 1 : -1) * (i % 11 === 10 ? 4 : 1), 10).hold(2);
    const full: Run = { learned: createLearned(30_000), sweep: createSweepState(ROW), verdicts: [] };
    const late: Run = { learned: createLearned(30_000), sweep: createSweepState(ROW), verdicts: [] };
    const start = 37;
    const usuals = new Set<number>();
    let compared = 0;
    tape.columns.forEach((column, index) => {
      stepLearned(full.learned, full.sweep, column, SLOT_MS, HIGH);
      if (index < start) return;
      stepLearned(late.learned, late.sweep, column, SLOT_MS, HIGH);
      if (!late.learned.steady) return;
      expect([late.learned.usual, late.learned.perSecond]).toEqual([full.learned.usual, full.learned.perSecond]);
      usuals.add(full.learned.usual);
      compared += 1;
    });
    expect(compared).toBeGreaterThan(100);
    expect(usuals.size).toBeGreaterThan(1);
  });

  it("keeps the same normal volume whatever slot the run started on, on a thin market too: the mean adds the memory's values in one order, not from wherever the ring stands (#46 review)", () => {
    const tape = new Tape();
    for (let i = 0; i < 150; i += 1) tape.jump(i % 2 === 0 ? 1 : -1).hold(2);
    const thin = tape.columns.map((column, index) => (index % 4 === 0 ? { ...column, buy: [[BASE_ROW - 20, 0.1 * ((index * 7) % 11) + 0.07] as [number, number]], sell: [] } : { ...column, buy: [], sell: [] }));
    const full: Run = { learned: createLearned(30_000), sweep: createSweepState(ROW), verdicts: [] };
    const late: Run = { learned: createLearned(30_000), sweep: createSweepState(ROW), verdicts: [] };
    let compared = 0;
    thin.forEach((column, index) => {
      stepLearned(full.learned, full.sweep, column, SLOT_MS, HIGH);
      if (index < 37) return;
      stepLearned(late.learned, late.sweep, column, SLOT_MS, HIGH);
      if (!late.learned.steady) return;
      expect(late.learned.perSecond).toBe(full.learned.perSecond);
      compared += 1;
    });
    expect(compared).toBeGreaterThan(100);
    expect(full.learned.perSecond).toBeGreaterThan(0);
    const sorted = [...full.learned.traded.values].sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length / 2)]).toBe(0);
  });

  it("is steady once a recompute finds both memories full, sixty windows of moves and thirty minutes of volume, whichever fills last; never before settleSpanMs of data (#46 review)", () => {
    const at = (columns: readonly LiquidityColumn[], windowMs: number): number => {
      const { full, steady } = memoryTimes(columns, windowMs);
      const every = Math.max(MIN_RECOMPUTE_MS, windowMs / 2);
      expect(steady).toBe(Math.ceil(full / every) * every);
      expect(steady - columns[0].ts).toBeGreaterThanOrEqual(settleSpanMs(windowMs));
      return full - columns[0].ts;
    };
    const plain = new Tape().background(70).columns;
    const plainFull = at(plain, 30_000);
    expect(plainFull).toBe((MOVE_WINDOWS + 1) * 30_000);
    expect((plain[0].ts + plainFull) % MIN_RECOMPUTE_MS).not.toBe(0);
    const blindStart = new Tape();
    blindStart.blind = true;
    blindStart.hold(100);
    blindStart.blind = false;
    expect(at(blindStart.hold(1).background(70).columns, 30_000)).toBe(100 * SLOT_MS + VOLUME_MEMORY_MS);
    expect(at(new Tape().background(200).columns, 90_000)).toBe((MOVE_WINDOWS + 1) * 90_000);
    expect(at(new Tape().gap(50_000).background(380).columns, 180_000)).toBe((MOVE_WINDOWS + 1) * 180_000);
    expect(settleSpanMs(30_000)).toBe(VOLUME_MEMORY_MS + 30_000);
    expect(settleSpanMs(10_000)).toBe(VOLUME_MEMORY_MS);
    expect(settleSpanMs(4_200_000)).toBe((MOVE_WINDOWS + 1) * 4_200_000);
  });

  it("syncs at the first column after it is steady that has a price and no push open, so every push opened after it is the same whatever column the run started from (#46 review)", () => {
    const check = (columns: readonly LiquidityColumn[]): { firstSteady: Snapshot; synced: Snapshot; out: Run } => {
      const { snaps, out } = snapshots(columns);
      const firstSteady = snaps.findIndex((snap) => snap.steady);
      const synced = snaps.findIndex((snap) => snap.syncId !== Number.POSITIVE_INFINITY);
      expect(firstSteady).toBeGreaterThan(0);
      expect(synced).toBeGreaterThanOrEqual(firstSteady);
      expect([snaps[synced].steady, snaps[synced].open, snaps[synced].priced]).toEqual([true, false, true]);
      for (const snap of snaps.slice(firstSteady, synced)) expect(snap.open || !snap.priced).toBe(true);
      return { firstSteady: snaps[firstSteady], synced: snaps[synced], out };
    };
    const staircase = new Tape().background(58, 1);
    for (let i = 0; i < 16; i += 1) staircase.jump(1, 10);
    staircase.hold(20);
    const across = check(staircase.columns);
    expect(across.firstSteady.open).toBe(true);
    expect(across.synced.ts).toBeGreaterThan(across.firstSteady.ts);
    expect(across.out.learned.syncId).toBe(across.out.sweep.nextId);
    const blanks = new Tape().background(62, 1).blank(3).hold(20);
    const blankSteady = check(blanks.columns);
    expect(blankSteady.firstSteady.priced).toBe(false);
    expect(blankSteady.synced.ts).toBe(blankSteady.firstSteady.ts + 3 * SLOT_MS);
  });

  it("settles the pushes judged after sixty scored pushes opened since the sync; a push opened before the sync or one whose volume stayed unknown does not count (#46 review)", () => {
    const build = (blindFrom: number): Tape => {
      const tape = new Tape().background(25, 1);
      let blinded = false;
      for (let i = 0; i < 100; i += 1) {
        if (!blinded && tape.ts >= blindFrom) {
          blinded = true;
          for (const column of tape.columns.slice(-3)) {
            delete column.buy;
            delete column.sell;
          }
        }
        tape.jump(i % 2 === 0 ? 5 : -5, 30 + ((i * 41) % 150)).hold(5);
      }
      return tape;
    };
    const { snaps, out } = snapshots(build(Number.POSITIVE_INFINITY).columns);
    const plain = out.learned;
    const syncTs = (snaps.find((snap) => snap.syncId !== Number.POSITIVE_INFINITY) as Snapshot).ts;
    expect(plain.syncId).toBeGreaterThan(MIN_RANK_PUSHES);
    expect(plain.settledId).toBe(plain.syncId + RANK_PUSHES);
    const blind = run(build(syncTs + 5 * MINUTE).columns, HIGH).learned;
    expect(blind.syncId).toBe(plain.syncId);
    expect(blind.settledId).toBe(plain.syncId + RANK_PUSHES + 1);
  });

  it("gives every push a later-starting run calls settled the same rows, times, volume and verdict as the run from the start, and nothing it calls settled is missing from that run (#46 review)", () => {
    const { tape, secondFrom } = regimes();
    const full = run(tape.columns, HIGH);
    const fullLight = liveSweeps(full.sweep);
    expect(fullLight.length).toBeLessThan(64);
    let sensitive = 0;
    for (const from of [tape.columns[200].ts, secondFrom, secondFrom + 20 * MINUTE]) {
      const late = run(tape.columns.filter((column) => column.ts >= from), HIGH);
      const lateLight = liveSweeps(late.sweep);
      const settled = lateLight.filter((box) => box.id >= late.learned.settledId);
      expect(settled.length).toBeGreaterThan(5);
      const firstStart = settled[0].startTs;
      expect(settled.map(boxKey)).toEqual(fullLight.filter((box) => box.startTs >= firstStart).map(boxKey));
      const fullKeys = new Set(fullLight.map(boxKey));
      const lateKeys = new Set(lateLight.map(boxKey));
      sensitive += lateLight.filter((box) => !fullKeys.has(boxKey(box))).length + fullLight.filter((box) => box.startTs >= from && !lateKeys.has(boxKey(box))).length;
    }
    expect(sensitive).toBeGreaterThan(0);
  });
});
