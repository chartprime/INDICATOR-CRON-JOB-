import { describe, expect, it } from "vitest";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import { DEFAULT_SWEEP_RULES, MAX_SWEEP_MS, createSweepState, liveSweeps, noteSweepClose, resetSweeps, stepSweeps, type SweepBox, type SweepRules, type SweepState } from "../sweepModel";

const T = 1_700_000_011_000;
const S = 1_000;
const ROW = 4;
const RULES: SweepRules = { ...DEFAULT_SWEEP_RULES, windowMs: 30 * S, minMoveRows: 6 };
const ANY: SweepRules = RULES;

type Flow = readonly (readonly [number, number])[];

function withFlow(c: LiquidityColumn, buy: Flow, sell: Flow): LiquidityColumn {
  c.buy = buy;
  c.sell = sell;
  c.prints = [...buy.map(([row, size]) => ({ ts: c.ts, price: row * ROW + ROW / 2, size, side: "buy" as const, id: null })), ...sell.map(([row, size]) => ({ ts: c.ts, price: row * ROW + ROW / 2, size, side: "sell" as const, id: null }))];
  c.printsFloor = 0;
  return c;
}

/** A column at `bidRow`; `flow` = [row, size] printed in that second, half as buys and half as sells. */
function column(ts: number, bidRow: number, flow: Flow = []): LiquidityColumn {
  const lo = bidRow - 40;
  const hi = bidRow + 41;
  const bid = new Float64Array(hi - lo + 1);
  const ask = new Float64Array(hi - lo + 1);
  bid[bidRow - lo] = 5;
  ask[bidRow + 1 - lo] = 5;
  return withFlow({ ts, lo, hi, bid, ask }, flow.map(([row, size]) => [row, size / 2] as const), flow.map(([row, size]) => [row, size / 2] as const));
}

/** Steps a column whose trades moved price into it: those trades printed during the previous column's window, so they go on that column. */
function stepMove(state: SweepState, c: LiquidityColumn, rules: SweepRules, columnMs = 0): void {
  const previous = state.samples[state.samples.length - 1]?.column;
  if (previous !== undefined && c.buy !== undefined && previous.buy !== undefined) {
    previous.buy = [...previous.buy, ...(c.buy ?? [])];
    previous.sell = [...(previous.sell ?? []), ...(c.sell ?? [])];
    previous.prints = [...(previous.prints ?? []), ...(c.prints ?? [])];
    c.buy = [];
    c.sell = [];
    c.prints = [];
  }
  stepSweeps(state, c, rules, columnMs);
}

function blind(ts: number, bidRow: number): LiquidityColumn {
  const c = column(ts, bidRow);
  delete c.buy;
  delete c.sell;
  delete c.prints;
  delete c.printsFloor;
  return c;
}

function spread(rowLo: number, rowHi: number, perRow: number): [number, number][] {
  const out: [number, number][] = [];
  for (let row = rowLo; row <= rowHi; row += 1) out.push([row, perRow]);
  return out;
}

/** 240 s of a slow drift, one row every ten seconds, printing `perRow` in each row crossed. */
function warm(state: SweepState, rules: SweepRules, from: number, perRow = 2, columns = 240): number {
  let ts = from;
  let row = 1000;
  for (let i = 0; i < columns; i += 1) {
    const next = row + (i % 10 === 0 ? (Math.floor(i / 60) % 2 === 0 ? 1 : -1) : 0);
    stepMove(state, column(ts, next, spread(Math.min(row, next), Math.max(row, next), perRow)), rules);
    row = next;
    ts += S;
  }
  return ts;
}

/** A move of `rows` rows over `seconds`, printing `perRow` in each row crossed (half buys, half sells). */
function sweep(state: SweepState, rules: SweepRules, from: number, fromRow: number, rows: number, perRow: number, direction: 1 | -1 = 1, seconds = 30): number {
  let ts = from;
  let previous = fromRow;
  for (let i = 1; i <= seconds; i += 1) {
    const row = fromRow + direction * Math.round((rows * i) / seconds);
    const flow = row === previous ? [] : spread(Math.min(previous, row) + (direction > 0 ? 1 : 0), Math.max(previous, row) - (direction > 0 ? 0 : 1), perRow);
    stepMove(state, column(ts, row, flow), rules);
    previous = row;
    ts += S;
  }
  return ts;
}

function sweepWith(state: SweepState, rules: SweepRules, from: number, fromRow: number, rows: number, seconds: number, buyPerRow: number, sellPerRow: number, direction: 1 | -1): number {
  let ts = from;
  let previous = fromRow;
  for (let i = 1; i <= seconds; i += 1) {
    const row = fromRow + direction * Math.round((rows * i) / seconds);
    const c = column(ts, row);
    if (row !== previous) {
      const crossed: number[] = [];
      for (let r = Math.min(previous, row) + 1; r <= Math.max(previous, row); r += 1) crossed.push(r);
      withFlow(c, crossed.map((r) => [r, buyPerRow] as const), crossed.map((r) => [r, sellPerRow] as const));
    }
    stepMove(state, c, rules, S);
    previous = row;
    ts += S;
  }
  return ts;
}

function hold(state: SweepState, rules: SweepRules, from: number, row: number, seconds: number): number {
  let ts = from;
  for (let i = 0; i < seconds; i += 1) {
    stepMove(state, column(ts, row), rules);
    ts += S;
  }
  return ts;
}

/** What the box's side printed in its rows over its columns, summed over every column the test stepped. */
function printedInto(columns: readonly LiquidityColumn[], box: SweepBox): number {
  const side = box.side === "ask" ? "buy" : "sell";
  let volume = 0;
  for (const c of columns) {
    if (c.ts < box.startTs || c.ts >= box.endTs) continue;
    for (const [row, size] of c[side] ?? []) if (row >= box.rowLo && row <= box.rowHi) volume += size;
  }
  return volume;
}

/** One row a second for `seconds`, each second printing 1 bought and 1 sold in the row price moved into. */
function trend(state: SweepState, columns: LiquidityColumn[], from: number, fromRow: number, seconds: number, direction: 1 | -1, rowsPerSecond = 1): number {
  let ts = from;
  let row = fromRow;
  for (let i = 0; i < seconds; i += 1) {
    row += direction * rowsPerSecond;
    const c = column(ts, row, [[row, 2]]);
    columns.push(c);
    stepMove(state, c, RULES, S);
    ts += S;
  }
  return ts;
}

describe("sweepModel", () => {
  it("boxes a move of at least the minimum rows, with the volume printed into it", () => {
    const state = createSweepState(ROW);
    const ts = warm(state, RULES, T);
    sweep(state, RULES, ts, 1000, 8, 2);
    const boxes = liveSweeps(state);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].side).toBe("ask");
    expect(boxes[0].rowHi - boxes[0].rowLo + 1).toBeGreaterThanOrEqual(8);
    expect(boxes[0].volume).toBeGreaterThan(0);
  });

  it("boxes a move over columns whose prints are unknown, with no volume", () => {
    const impulse = createSweepState(ROW);
    for (let i = 0; i < 60; i += 1) {
      const at = T + i * S;
      const row = 1000 + Math.round((8 * Math.max(0, i - 29)) / 30);
      stepMove(impulse, blind(at, row), ANY, S);
    }
    const boxes = liveSweeps(impulse);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].volume).toBeNull();
  });

  it("with columns further apart than the window (the 10-s history tier under a 5-s window), still compares each column with the previous one", () => {
    const state = createSweepState(ROW);
    const rules = { ...ANY, windowMs: 5 * S };
    const step = (at: number, row: number) => stepMove(state, column(at, row, spread(1000, 1012, 2)), rules, 10 * S);
    for (let i = 0; i < 30; i += 1) step(T + i * 10 * S, 1000);
    step(T + 300 * S, 1008);
    const boxes = liveSweeps(state);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ side: "ask", startTs: T + 290 * S, endTs: T + 300 * S });
  });

  it("counts the trades printed while price moved (the columns from the window's start up to its end), never the ten seconds after it, like 20:58:40 on 10-02: 0.13 BTC during, 37 BTC after", () => {
    const state = createSweepState(ROW);
    const rules = { ...ANY, windowMs: 5 * S };
    const deep = (at: number, row: number, buys: number, prints: number) => {
      const c = column(at, row);
      withFlow(c, buys > 0 ? [[1003, buys]] : [], []);
      c.prints = prints > 0 ? [{ ts: at, price: 1003 * ROW + 1, size: prints, side: "buy", id: null }] : [];
      return c;
    };
    for (let i = 0; i < 29; i += 1) stepSweeps(state, deep(T + i * 10 * S, 1000, 0, 0), rules, 10 * S);
    stepSweeps(state, deep(T + 290 * S, 1000, 0.13, 0.13), rules, 10 * S);
    stepSweeps(state, deep(T + 300 * S, 1006, 37, 37), rules, 10 * S);
    const box = liveSweeps(state)[0];
    expect(box).toMatchObject({ side: "ask", startTs: T + 290 * S, endTs: T + 300 * S });
    expect(box.volume).toBeCloseTo(0.13);
  });

  it("ignores a move under the minimum rows", () => {
    const state = createSweepState(ROW);
    const ts = warm(state, ANY, T);
    sweep(state, ANY, ts, 1000, 4, 2);
    expect(liveSweeps(state)).toHaveLength(0);
  });

  it("merges back-to-back qualifying windows in one direction into one box", () => {
    const state = createSweepState(ROW);
    let ts = warm(state, RULES, T);
    ts = sweep(state, RULES, ts, 1000, 8, 2);
    sweep(state, RULES, ts, 1008, 8, 2);
    const boxes = liveSweeps(state);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].rowHi - boxes[0].rowLo + 1).toBeGreaterThanOrEqual(16);
  });

  it("starts a new box when the direction flips", () => {
    const state = createSweepState(ROW);
    let ts = warm(state, RULES, T);
    ts = sweep(state, RULES, ts, 1000, 8, 2);
    const ask = liveSweeps(state)[0];
    expect(ask.open).toBe(true);
    stepMove(state, column(ts, 994, spread(994, 1008, 2)), RULES);
    const bid = state.boxes.find((box) => box.side === "bid");
    expect(bid).toBeDefined();
    expect(bid?.id).not.toBe(ask.id);
    expect(ask.rowLo).toBeGreaterThanOrEqual(1001);
  });

  it("keeps a box while price trades back through it without a close beyond it, however long", () => {
    const state = createSweepState(ROW);
    let ts = warm(state, RULES, T);
    ts = sweep(state, RULES, ts, 1000, 8, 2);
    const box = liveSweeps(state)[0];
    hold(state, RULES, ts, 990, 3 * 3_600);
    expect(box.endedAt).toBeNull();
    expect(liveSweeps(state)).toContain(box);
    const bids = state.boxes.filter((candidate) => candidate.side === "bid");
    expect(bids).toHaveLength(1);
    expect(bids[0].endedAt).toBeNull();
  });

  it("ends an ask box only when a later bar closes below its bottom: mitigated", () => {
    const state = createSweepState(ROW);
    const ts = warm(state, RULES, T);
    sweep(state, RULES, ts, 1000, 8, 2);
    const box = liveSweeps(state)[0];
    expect(box.side).toBe("ask");
    const later = box.endTs + S;
    noteSweepClose(state, later, later + 60 * S, box.rowLo + 2);
    noteSweepClose(state, later, later + 60 * S, box.rowHi + 5);
    noteSweepClose(state, later, later + 60 * S, box.rowLo);
    expect(box.endedAt).toBeNull();
    noteSweepClose(state, later, later + 60 * S, box.rowLo - 1);
    expect(liveSweeps(state)).toHaveLength(0);
    expect(box.endedBy).toBe("mitigated");
  });

  it("ends a bid box only when a later bar closes above its top", () => {
    const state = createSweepState(ROW);
    const ts = warm(state, RULES, T);
    sweep(state, RULES, ts, 1000, 8, 2, -1);
    const box = liveSweeps(state)[0];
    expect(box.side).toBe("bid");
    const later = box.endTs + S;
    noteSweepClose(state, later, later + 60 * S, box.rowHi);
    noteSweepClose(state, later, later + 60 * S, box.rowLo - 5);
    expect(box.endedAt).toBeNull();
    noteSweepClose(state, later, later + 60 * S, box.rowHi + 1);
    expect(liveSweeps(state)).toHaveLength(0);
  });

  it("never lets a candle the sweep happened in mitigate it, even closing beyond the far side; only a retest by a later candle does", () => {
    const state = createSweepState(ROW);
    const ts = warm(state, RULES, T);
    sweep(state, RULES, ts, 1000, 8, 2);
    const box = liveSweeps(state)[0];
    noteSweepClose(state, box.startTs - 5 * S, box.startTs + 55 * S, box.rowLo - 5);
    noteSweepClose(state, box.endTs - S, box.endTs + 59 * S, box.rowLo - 5);
    expect(box.endedAt).toBeNull();
    noteSweepClose(state, box.endTs, box.endTs + 60 * S, box.rowLo - 5);
    expect(box.endedBy).toBe("mitigated");
  });

  it("records the aggressive volume behind the move: the buys printed in the swept rows for a move up, the sells for a move down, over the whole sweep", () => {
    const up = createSweepState(ROW);
    let ts = warm(up, RULES, T);
    ts = hold(up, RULES, ts, 1000, 30);
    sweepWith(up, RULES, ts, 1000, 16, 60, 3, 1, 1);
    const ask = liveSweeps(up)[0];
    expect(ask.side).toBe("ask");
    expect(ask.rowHi - ask.rowLo + 1).toBe(16);
    expect(ask.volume).toBeCloseTo(48);
    const down = createSweepState(ROW);
    ts = warm(down, RULES, T);
    ts = hold(down, RULES, ts, 1000, 30);
    sweepWith(down, RULES, ts, 1000, 16, 60, 3, 1, -1);
    const bid = liveSweeps(down)[0];
    expect(bid.side).toBe("bid");
    expect(bid.volume).toBeCloseTo(16);
  });

  it("counts a push from its first column however long it runs: past ten minutes the prints of the samples it drops stay in the volume (PR #39 review)", () => {
    const state = createSweepState(ROW);
    const columns = [column(T, 1000, [[900, 8]])];
    stepSweeps(state, columns[0], RULES, S);
    trend(state, columns, T + S, 1000, 1_200, 1);
    const boxes = liveSweeps(state);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ side: "ask", startTs: T, endTs: T + 1_200 * S, open: true });
    expect(state.samples.length).toBeLessThanOrEqual(MAX_SWEEP_MS / S + 1);
    expect(printedInto(columns, boxes[0])).toBeGreaterThan(1_190);
    expect(boxes[0].volume).toBe(printedInto(columns, boxes[0]));
  });

  it("starts the next box's volume from nothing: what a long push carried from its dropped samples is not counted into the box after it (PR #39 review)", () => {
    const state = createSweepState(ROW);
    const columns = [column(T, 1000)];
    stepSweeps(state, columns[0], RULES, S);
    const top = trend(state, columns, T + S, 1000, 700, 1);
    const flip = trend(state, columns, top, 1700, 1, -1, 100);
    expect(state.open?.side).toBe("bid");
    trend(state, columns, flip, 1600, 79, -1, 10);
    const boxes = liveSweeps(state);
    expect(boxes.map((box) => box.side)).toEqual(["ask", "bid"]);
    expect(boxes[1].rowLo).toBeLessThan(1_000);
    expect(printedInto(columns, boxes[1])).toBeGreaterThan(0);
    expect(boxes[1].volume).toBe(printedInto(columns, boxes[1]));
  });

  it("keeps a long push's volume unknown when the samples it dropped had no known prints, instead of counting only what is left (PR #39 review)", () => {
    const state = createSweepState(ROW);
    let ts = T;
    let row = 1000;
    for (let i = 0; i < 100; i += 1) {
      stepSweeps(state, blind(ts, row), RULES, S);
      ts += S;
      row += 1;
    }
    const columns: LiquidityColumn[] = [];
    trend(state, columns, ts, row - 1, 700, 1);
    const boxes = liveSweeps(state);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].startTs).toBe(T);
    expect(state.samples[0].ts).toBeGreaterThan(T + 100 * S);
    expect(boxes[0].volume).toBeNull();
    trend(state, columns, ts + 700 * S, row - 1 + 700, 40, -1, 10);
    const next = liveSweeps(state)[1];
    expect(next.side).toBe("bid");
    expect(printedInto(columns, next)).toBeGreaterThan(0);
    expect(next.volume).toBe(printedInto(columns, next));
  });

  it("does not box a move across a hole of more than twenty seconds in the columns, where the prints are missing", () => {
    const state = createSweepState(ROW);
    let ts = warm(state, RULES, T);
    const step = (at: number, row: number) => stepMove(state, column(at, row), RULES, S);
    for (let i = 0; i < 5; i += 1) step(ts + i * S, 1000);
    ts += 5 * S;
    stepMove(state, column(ts + 25 * S, 1008, spread(1001, 1008, 2)), RULES, S);
    for (let i = 1; i < 25; i += 1) step(ts + 25 * S + i * S, 1008);
    expect(state.gapTs).toBe(ts + 25 * S);
    expect(liveSweeps(state)).toHaveLength(0);
    ts += 50 * S;
    sweep(state, RULES, ts + S, 1008, 8, 2);
    expect(liveSweeps(state)).toHaveLength(1);
  });

  it("rides through the runtime's short skips: a move across a five-second hole in one-second columns is still a box, on the fine tier as on the ten-second one", () => {
    for (const columnMs of [S, 0]) {
      const state = createSweepState(ROW);
      let ts = warm(state, RULES, T);
      const step = (at: number, row: number) => stepMove(state, column(at, row), RULES, columnMs);
      for (let i = 0; i < 30; i += 1) step(ts + i * S, 1000);
      ts += 30 * S;
      stepMove(state, column(ts + 5 * S, 1008, spread(1001, 1008, 2)), RULES, columnMs);
      expect(state.gapTs).toBe(-Infinity);
      expect(liveSweeps(state).map((box) => [box.rowLo, box.rowHi])).toEqual([[1001, 1008]]);
    }
  });

  it("ignores a column older than the last one", () => {
    const state = createSweepState(ROW);
    const ts = warm(state, RULES, T);
    sweep(state, RULES, ts, 1000, 8, 2);
    const before = state.lastTs;
    stepMove(state, column(ts - 10 * S, 900), RULES);
    expect(state.lastTs).toBe(before);
    expect(liveSweeps(state)).toHaveLength(1);
  });

  it("reset clears the boxes and takes the new row width", () => {
    const state = createSweepState(ROW);
    const ts = warm(state, RULES, T);
    sweep(state, RULES, ts, 1000, 8, 2);
    resetSweeps(state, 8);
    expect(liveSweeps(state)).toHaveLength(0);
    expect(state.samples).toHaveLength(0);
    expect(state.rowWidth).toBe(8);
  });
});
