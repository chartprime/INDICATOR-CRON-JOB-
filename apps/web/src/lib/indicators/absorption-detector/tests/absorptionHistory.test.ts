// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ColumnHistoryStream } from "../../passive-liquidity/columnHistoryStream";
import type { HistoryRequest } from "../../passive-liquidity/heatmapHistory";
import type { DecodedHistoryPage, HistoryWindow } from "../../passive-liquidity/heatmapHistoryDecode";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import type { BarClose } from "../../institutional-order-blocks-v2/bandTracker";
import { AbsorptionTracker, readPrint, type AbsorptionRecord } from "../absorptionEngine";
import { AbsorptionHistory, HISTORY_BLOCK_MS, HISTORY_WARMUP_MS, type HistoryBars } from "../absorptionHistory";
import { AbsorptionHistoryStore } from "../absorptionHistoryStore";
import type { AbsorptionRules } from "../absorptionSettings";
import { ROW, RULES, STEP, col, type Col } from "./absorptionFixtures";

const H = 3_600_000;
const MINUTE = 60_000;
const MARGIN = Math.max(RULES.quietMs, RULES.breakWindowMs);
const DAY = 24 * H;
const C = Math.floor(Date.now() / DAY) * DAY - 2 * DAY;
const ID = { provider: "BINANCE" as const, marketKind: "PERPETUAL", symbol: "BTCUSDT" };
const QUIET_ROW = 25;
const BELOW_THE_WALL = 19;

const shape = (records: readonly AbsorptionRecord[]) => records.map((record) => JSON.stringify([record.key, record.side, record.band, record.ts, record.attackTs, record.resting, record.absorbed, record.yardstick, record.refills, record.trail, record.endTs, record.endReason]));
const read = (records: readonly AbsorptionRecord[], rules: AbsorptionRules = RULES) => records.map((record) => readPrint(record, rules));

function columnsOver(fromTs: number, toTs: number, specAt: (ts: number) => Col): LiquidityColumn[] {
  const out: LiquidityColumn[] = [];
  for (let ts = fromTs; ts < toTs; ts += STEP) out.push(col(ts, specAt(ts)));
  return out;
}

function windowsOf(columns: readonly LiquidityColumn[]): HistoryWindow[] {
  const byWindow = new Map<number, LiquidityColumn[]>();
  for (const column of columns) {
    const ts = Math.floor(column.ts / 300_000) * 300_000;
    const list = byWindow.get(ts) ?? [];
    list.push(column);
    byWindow.set(ts, list);
  }
  return [...byWindow.entries()].sort((a, b) => a[0] - b[0]).map(([ts, list]) => ({ ts, state: "COVERED" as const, columns: list }));
}

function closesEveryMinute(fromTs: number, toTs: number, through: readonly number[] = []): BarClose[] {
  const closes: BarClose[] = [];
  for (let ts = fromTs + MINUTE; ts <= toTs; ts += MINUTE) closes.push({ ts, row: through.includes(ts) ? BELOW_THE_WALL : QUIET_ROW });
  return closes;
}

/** A wall standing five minutes before `start`, hit for 120 twice from `start` on -- all of it and more, the record at the second hit -- and thinned to a fifth after. */
function attackAt(start: number, wall = 200): (ts: number) => Col | null {
  return (ts) => {
    if (ts < start - 5 * MINUTE || ts > start + 10 * MINUTE) return null;
    if (ts < start) return { wall };
    if (ts === start) return { wall, sell: 120 };
    if (ts === start + STEP) return { wall: wall * 0.4, sell: 120 };
    return { wall: wall * 0.2 };
  };
}

function scene(...attacks: ((ts: number) => Col | null)[]): (ts: number) => Col {
  return (ts) => {
    for (const attack of attacks) {
      const spec = attack(ts);
      if (spec !== null) return spec;
    }
    return { wall: 0 };
  };
}

function host(columns: readonly LiquidityColumn[], rowWidth = ROW) {
  const windows = windowsOf(columns);
  const queue: HistoryRequest[] = [];
  const asked: HistoryRequest[] = [];
  const failing = new Set<number>();
  const split = new Set<number>();
  const stream = new ColumnHistoryStream({ request: (request) => { queue.push(request); asked.push(request); }, maxPerMinute: 100_000, retryMs: 1 });
  stream.setIdentity(ID);
  const page = (request: HistoryRequest): DecodedHistoryPage => {
    const half = split.delete(request.fromTs) ? request.fromTs + 30 * MINUTE : null;
    const toTs = half ?? request.toTs;
    return {
      available: true, generation: "g", levelMs: 10_000, rowFactor: 1, rowWidth, next: half,
      span: { oldest: windows[0]?.ts ?? null, newest: windows[windows.length - 1]?.ts ?? null },
      windows: windows.filter((window) => window.ts >= Math.floor(request.fromTs / 300_000) * 300_000 && window.ts < toTs),
    };
  };
  const answer = (request: HistoryRequest) => {
    if (failing.delete(request.fromTs)) stream.fail(request.requestId);
    else stream.accept(request.requestId, page(request));
  };
  const flush = () => {
    for (let guard = 0; queue.length > 0 && guard < 10_000; guard += 1) answer(queue.shift()!);
  };
  const step = () => {
    const request = queue.pop();
    if (request !== undefined) answer(request);
  };
  return { stream, asked, flush, step, failing, split, pending: () => queue.length };
}

function reference(columns: readonly LiquidityColumn[], closes: readonly BarClose[], fromTs: number, toTs: number): AbsorptionRecord[] {
  const records = new AbsorptionTracker().update({ epoch: 1, deep: { columns: [...columns], columnMs: STEP }, fine: { columns: [], columnMs: 1_000 } }, ROW, RULES, columns[columns.length - 1].ts + STEP, closes);
  return records.filter((record) => record.ts >= fromTs && record.ts < toTs);
}

/** What the loader is built to find: each UTC day judged by one tracker started eight hours before its midnight, whatever else is loaded. */
function blockReference(columns: readonly LiquidityColumn[], closes: readonly BarClose[], fromTs: number, toTs: number): AbsorptionRecord[] {
  const out: AbsorptionRecord[] = [];
  for (let block = Math.floor(fromTs / DAY) * DAY; block < toTs; block += DAY) {
    const fed = columns.filter((column) => column.ts >= block - HISTORY_WARMUP_MS && column.ts < Math.min(block + DAY, toTs) + MARGIN);
    out.push(...reference(fed, closes, Math.max(block, fromTs), Math.min(block + DAY, toTs)));
  }
  return out.sort((a, b) => a.ts - b.ts || a.band - b.band);
}

const bars = (closes: readonly BarClose[], fromTs: number, intervalMs = MINUTE): HistoryBars => ({ closes, intervalMs, fromTs });
const settle = async (pending: () => number = () => 0, until = 2_000) => {
  const started = Date.now();
  do await new Promise((resolve) => setTimeout(resolve, 15));
  while (pending() === 0 && Date.now() - started < until);
};

describe("absorption history: the live tracker's algorithm over the host's columns", () => {
  // Measured 2026-10-04 on 30 h of BTC perp against one tracker started ten hours earlier: with eight hours of warm-up every
  // sphere on 1m, 5m, 15m and 4h matched, refills and opacity included; with one hour, 19 of 41 drawn 1m spheres had another
  // refill count. A wall standing longer than the warm-up still counts fewer refills, as the live tracker does after a reload.
  it("reads each UTC day from eight hours before its midnight", () => {
    expect(HISTORY_WARMUP_MS).toBe(8 * H);
    expect(HISTORY_BLOCK_MS).toBe(DAY);
  });

  it("finds over twelve hours across midnight exactly what one continuous tracker finds with the chart's closes, every field of the record, a day at a time", () => {
    const start = C - DAY - HISTORY_WARMUP_MS;
    const spec = scene(attackAt(C - DAY - 3 * H), attackAt(C - 3 * H), attackAt(C - 30_000), attackAt(C + H - 30_000), attackAt(C + 3 * H + 40 * MINUTE, 120), attackAt(C + 6 * H - 10_000), attackAt(C + 7 * H + 5 * MINUTE));
    const columns = columnsOver(start, C + 8 * H + MARGIN, spec);
    const closes = closesEveryMinute(start, C + 8 * H + MARGIN, [C - DAY - H]);
    const { stream, flush, asked } = host(columns);
    const history = new AbsorptionHistory(stream);
    history.setRules(RULES, ROW, MINUTE);
    history.want(C - 4 * H, C + 8 * H, C + 8 * H, 48 * H, null, bars(closes, start));
    expect(history.running).toBe(true);
    flush();
    expect(history.running).toBe(false);
    const expected = reference(columns, closes, C - 4 * H, C + 8 * H);
    expect(expected).toHaveLength(6);
    expect([expected.some((record) => record.ts < C), expected.some((record) => record.ts >= C)]).toEqual([true, true]);
    expect(shape(history.records.filter((record) => record.ts >= C - 4 * H))).toEqual(shape(expected));
    expect(history.status().reachTs).toBe(C - DAY);
    expect(reference(columns, closes, start, C - DAY)).toHaveLength(1);
    expect(history.records.every((record) => record.ts >= C - DAY)).toBe(true);
    expect(asked.every((request) => request.levelMs === 10_000 && request.rowFactor === 1)).toBe(true);
    expect(Math.min(...asked.map((request) => request.fromTs))).toBe(start);
    expect(asked.filter((request) => request.fromTs === C - HISTORY_WARMUP_MS)).toHaveLength(2);
  });

  it("reads past the end of a day by the break window, so a wall closed through just after midnight breaks the sphere printed just before it, as one continuous tracker reads it", () => {
    const start = C - DAY - HISTORY_WARMUP_MS;
    const columns = columnsOver(start, C + H, scene(attackAt(C - MINUTE)));
    const closes = closesEveryMinute(start, C + H, [C + 2 * MINUTE]);
    const { stream, flush } = host(columns);
    const history = new AbsorptionHistory(stream);
    history.setRules(RULES, ROW, MINUTE);
    history.want(C - 4 * H, C + 30 * MINUTE, C + 30 * MINUTE, 48 * H, null, bars(closes, start));
    flush();
    expect(history.running).toBe(false);
    const expected = reference(columns, closes, C - 4 * H, C + 30 * MINUTE);
    expect(expected.map((record) => [record.ts - C, record.endTs, record.endReason, readPrint(record, RULES)?.broken])).toEqual([[-50_000, C + 2 * MINUTE, "closed", true]]);
    expect(shape(history.records.filter((record) => record.ts >= C - 4 * H))).toEqual(shape(expected));
  });

  it("gives an hour the same spheres whichever view asked for it first, a wall's refills counted from the same hour", () => {
    const start = C - HISTORY_WARMUP_MS;
    const attack = C + 4 * H + 10 * MINUTE;
    const longWall = (ts: number): Col | null => (ts < C - 7 * H || ts >= attack - 5 * MINUTE ? null : { wall: (ts - C) % H < 2 * MINUTE && (ts - C) % H >= 0 ? 80 : 200 });
    const columns = columnsOver(start, C + 6 * H + MARGIN, scene(attackAt(attack), longWall));
    const closes = closesEveryMinute(start, C + 6 * H + MARGIN);
    const runFor = (fromTs: number, toTs: number) => {
      const { stream, flush } = host(columns);
      const history = new AbsorptionHistory(stream);
      history.setRules(RULES, ROW, MINUTE);
      history.want(fromTs, toTs, C + 6 * H, 48 * H, null, bars(closes, start));
      flush();
      return history.records.filter((record) => record.ts >= C + 4 * H && record.ts < C + 5 * H);
    };
    const wide = runFor(C, C + 6 * H);
    expect(wide).toHaveLength(1);
    expect(wide[0].refills).toBeGreaterThanOrEqual(10);
    expect(shape(runFor(C + 4 * H, C + 5 * H))).toEqual(shape(wide));
  });

  it("ends a wall at a candle that closes through it, as the live tracker does, so an attack across that close is not a sphere", () => {
    const attack = C + 2 * H + 20 * MINUTE;
    const spec = (ts: number): Col => (ts < attack ? { wall: 200 } : ts === attack ? { wall: 200, sell: 120 } : ts === attack + STEP ? { wall: 80 } : ts === attack + 2 * STEP ? { wall: 80, sell: 120 } : { wall: 40 });
    const columns = columnsOver(C - 8 * H, C + 4 * H, spec);
    const run = (closes: BarClose[]) => {
      const { stream, flush } = host(columns);
      const history = new AbsorptionHistory(stream);
      history.setRules(RULES, ROW, MINUTE);
      history.want(C, C + 3 * H, C + 3 * H, 48 * H, null, bars(closes, C - 8 * H));
      flush();
      return history.records;
    };
    const quiet = closesEveryMinute(C - 8 * H, C + 4 * H);
    expect(read(run(quiet)).map((print) => print?.share)).toEqual([1]);
    const through = [...quiet];
    through.splice(through.findIndex((close) => close.ts > attack + STEP), 0, { ts: attack + STEP + 1, row: BELOW_THE_WALL });
    expect(run(through)).toEqual([]);
    expect(reference(columns, through, C, C + 3 * H)).toEqual([]);
    // A close through the wall after the sphere printed keeps the sphere and marks it broken, in the loader as in the live tracker.
    const later = [...quiet];
    later.splice(later.findIndex((close) => close.ts > attack + 3 * STEP), 0, { ts: attack + 3 * STEP + 1, row: BELOW_THE_WALL });
    expect(read(run(later)).map((print) => [print?.share, print?.broken])).toEqual([[1, true]]);
    expect(shape(run(later))).toEqual(shape(reference(columns, later, C, C + 3 * H)));
  });

  it("asks nothing until the chart's candles reach eight hours before the day's midnight", () => {
    const columns = columnsOver(C - 8 * H, C + 4 * H + MARGIN, scene(attackAt(C + 20 * MINUTE), attackAt(C + 2 * H + 20 * MINUTE)));
    const { stream, flush, asked } = host(columns);
    const history = new AbsorptionHistory(stream);
    history.setRules(RULES, ROW, MINUTE);
    history.want(C, C + 4 * H, C + 4 * H, 48 * H, null, null);
    history.want(C, C + 4 * H, C + 4 * H, 48 * H, null, bars([], C - H));
    history.want(C, C + 4 * H, C + 4 * H, 48 * H, null, bars([], C - 8 * H));
    expect(asked).toEqual([]);
    const closes = closesEveryMinute(C - 8 * H, C + 4 * H + MARGIN);
    history.want(C, C + 4 * H, C + 4 * H, 48 * H, null, bars(closes, C - 7 * H));
    expect(asked).toEqual([]);
    history.want(C, C + 4 * H, C + 4 * H, 48 * H, null, bars(closes, C - 8 * H));
    flush();
    expect(history.status().reachTs).toBe(C);
    expect(Math.min(...asked.map((request) => request.fromTs))).toBe(C - 8 * H);
    expect(history.records.length).toBeGreaterThan(0);
  });

  it("keeps each timeframe apart and brings one back without asking again; says which times it covers, never past the live seam", () => {
    const seam = C + 2 * H + 30 * MINUTE;
    const columns = columnsOver(C - 8 * H, C + 3 * H + MARGIN, scene(attackAt(C + 20 * MINUTE), attackAt(C + 2 * H + 10 * MINUTE), attackAt(C + 2 * H + 40 * MINUTE)));
    const closes = closesEveryMinute(C - 8 * H, C + 3 * H + MARGIN);
    const { stream, flush, asked } = host(columns);
    const history = new AbsorptionHistory(stream);
    history.setRules(RULES, ROW, MINUTE);
    history.want(C, C + 3 * H, seam, 48 * H, null, bars(closes, C - 8 * H));
    flush();
    const minute = shape(history.records);
    expect(history.records.every((record) => record.ts < seam)).toBe(true);
    expect(history.records.some((record) => record.ts >= C + 2 * H)).toBe(true);
    expect([history.covers(C), history.covers(seam - 1), history.covers(seam), history.covers(C - 1)]).toEqual([true, true, false, false]);
    const count = asked.length;
    history.setRules(RULES, ROW, H);
    expect(history.records).toEqual([]);
    expect(history.covers(C)).toBe(false);
    history.setRules({ ...RULES, wallFloor: () => 999 }, ROW, MINUTE);
    expect(shape(history.records)).toEqual(minute);
    expect(history.covers(C)).toBe(true);
    history.want(C, C + 3 * H, seam, 48 * H, null, bars(closes, C - 8 * H));
    expect(asked.length).toBe(count);
  });

  it("carries the newest hour's last attack on through the live columns past the host's end, so its record holds the whole attack's flow", () => {
    const seam = C + H + 30 * MINUTE;
    const late = seam - 40_000;
    const spec = (ts: number): Col => {
      if (ts < late - 5 * MINUTE || ts > seam + 10 * MINUTE) return { wall: 0 };
      if (ts < late) return { wall: 200 };
      if (ts === late) return { wall: 200, sell: 120 };
      if (ts === late + STEP) return { wall: 80, sell: 120 };
      if (ts === seam || ts === seam + STEP) return { wall: 80, sell: 120 };
      return { wall: 40 };
    };
    const all = columnsOver(C - 8 * H, seam + 2 * MARGIN, spec);
    const hostColumns = all.filter((column) => column.ts < seam);
    const live = all.filter((column) => column.ts >= seam);
    const closes = closesEveryMinute(C - 8 * H, seam + 2 * MARGIN);
    const { stream, flush } = host(hostColumns);
    const history = new AbsorptionHistory(stream);
    history.setRules(RULES, ROW, MINUTE);
    history.want(C, seam, seam, 48 * H, { columns: live, columnMs: STEP }, bars(closes, C - 8 * H));
    flush();
    const expected = reference(all, closes, C, seam);
    expect(expected.map((record) => [record.ts, record.absorbed, record.trail.length])).toEqual([[late + STEP, 480, 3]]);
    expect(shape(history.records)).toEqual(shape(expected));
    const { stream: alone, flush: flushAlone } = host(hostColumns);
    const unjudged = new AbsorptionHistory(alone);
    unjudged.setRules(RULES, ROW, MINUTE);
    unjudged.want(C, seam, seam, 48 * H, null, bars(closes, C - 8 * H));
    flushAlone();
    expect(unjudged.running).toBe(false);
    expect(unjudged.records.map((record) => [record.ts, record.absorbed, record.trail.length])).toEqual([[late + STEP, 240, 1]]);
  });

  it("asks an hour again after a failed fetch and never counts a column twice", async () => {
    const warmup = HISTORY_WARMUP_MS;
    const columns = columnsOver(C - warmup, C + 3 * H + MARGIN, scene(attackAt(C + H + 20 * MINUTE), attackAt(C + 2 * H + 10 * MINUTE)));
    const closes = closesEveryMinute(C - warmup, C + 3 * H + MARGIN);
    const { stream, flush, failing, split, asked, pending } = host(columns);
    failing.add(C + H);
    split.add(C + 2 * H);
    failing.add(C + 2 * H + 30 * MINUTE);
    const history = new AbsorptionHistory(stream);
    history.setRules(RULES, ROW, MINUTE);
    history.want(C, C + 3 * H, C + 3 * H, 48 * H, null, bars(closes, C - warmup));
    flush();
    for (let guard = 0; history.running && guard < 100; guard += 1) {
      await settle(pending);
      flush();
    }
    expect(history.running).toBe(false);
    expect(asked.filter((request) => request.fromTs === C + H)).toHaveLength(2);
    expect(asked.filter((request) => request.fromTs === C + 2 * H).length).toBeGreaterThanOrEqual(2);
    expect([failing.size, split.size]).toEqual([0, 0]);
    expect(shape(history.records)).toEqual(shape(reference(columns, closes, C, C + 3 * H)));
  });

  it("shows nothing of a reach before every hour of it is judged, and drops a run the chart asked away from with the hours it had not finished", () => {
    const start = C - DAY - HISTORY_WARMUP_MS;
    const columns = columnsOver(start, C + 3 * H + MARGIN, scene(attackAt(C + 20 * MINUTE)));
    const closes = closesEveryMinute(start, C + 3 * H + MARGIN);
    const { stream, step, flush, asked } = host(columns);
    const history = new AbsorptionHistory(stream);
    history.setRules(RULES, ROW, MINUTE);
    history.want(C, C + 3 * H, C + 3 * H, 48 * H, null, bars(closes, start));
    for (let guard = 0; guard < 6; guard += 1) step();
    expect([history.running, history.records, history.covers(C), history.status().loading]).toEqual([true, [], false, true]);
    history.want(C - 20 * H, C - 19 * H, C + 3 * H, 48 * H, null, bars(closes, start));
    expect(history.records).toEqual([]);
    expect(history.running).toBe(true);
    expect(asked.some((request) => request.fromTs === C - DAY - HISTORY_WARMUP_MS)).toBe(true);
    flush();
    expect([history.covers(C - 20 * H), history.covers(C), history.records, history.status().loading]).toEqual([true, false, [], false]);
  });

  it("shows a day only once whole, keeps it on screen while a longer reach loads, and gives each day the same spheres whatever the reach", () => {
    const seam = C + 6 * H;
    const start = C - 3 * DAY - HISTORY_WARMUP_MS;
    const spec = scene(attackAt(seam - 3 * DAY + 2 * H), attackAt(seam - 2 * DAY - 2 * H), attackAt(seam - DAY - 5 * H), attackAt(seam - DAY + 40 * MINUTE), attackAt(seam - 3 * H), attackAt(seam - 25 * MINUTE));
    const columns = columnsOver(start, seam + MARGIN, spec);
    const closes = closesEveryMinute(start, seam + MARGIN);
    const day = blockReference(columns, closes, seam - DAY, seam);
    const threeDays = blockReference(columns, closes, seam - 3 * DAY, seam);
    expect(shape(day)).not.toEqual(shape(reference(columns, closes, seam - DAY, seam)));
    expect(day).toHaveLength(3);
    expect(threeDays).toHaveLength(6);

    const { stream, step, flush } = host(columns);
    const history = new AbsorptionHistory(stream);
    history.setRules(RULES, ROW, MINUTE);
    history.want(seam - DAY, seam, seam, DAY, null, bars(closes, start));
    expect(history.status().loading).toBe(true);
    let early = 0;
    for (let guard = 0; guard < 40 && history.running; guard += 1) {
      step();
      if (history.records.length > 0) early += 1;
    }
    expect(early).toBe(0);
    flush();
    expect([history.running, history.status().loading]).toEqual([false, false]);
    expect(shape(history.records)).toEqual(shape(day));
    expect([history.covers(seam - DAY), history.covers(seam - 1), history.covers(seam - DAY - 1)]).toEqual([true, true, false]);

    history.want(seam - 3 * DAY, seam, seam, 3 * DAY, null, bars(closes, start));
    expect([history.running, history.status().loading]).toEqual([true, true]);
    expect(shape(history.records)).toEqual(shape(day));
    for (let guard = 0; guard < 60 && history.running; guard += 1) {
      step();
      expect(shape(history.records.filter((record) => record.ts >= seam - DAY))).toEqual(shape(day));
      expect(history.covers(seam - DAY - 1)).toBe(false);
    }
    flush();
    expect([history.running, history.status().loading]).toEqual([false, false]);
    expect(shape(history.records)).toEqual(shape(threeDays));
    expect(history.covers(seam - 3 * DAY)).toBe(true);

    const { stream: direct, flush: flushDirect } = host(columns);
    const wide = new AbsorptionHistory(direct);
    wide.setRules(RULES, ROW, MINUTE);
    wide.want(seam - 3 * DAY, seam, seam, 3 * DAY, null, bars(closes, start));
    flushDirect();
    expect(shape(wide.records)).toEqual(shape(threeDays));
    expect(shape(wide.records.filter((record) => record.ts >= seam - DAY))).toEqual(shape(day));
  });

  it("reaches only the days the chart's candles can warm up, shows them, and is not loading what it cannot reach", () => {
    const seam = C + 6 * H;
    const start = C - 3 * DAY - HISTORY_WARMUP_MS;
    const columns = columnsOver(start, seam + MARGIN, scene(attackAt(seam - 3 * DAY + 2 * H), attackAt(seam - 2 * DAY + 2 * H), attackAt(seam - 3 * H)));
    const closes = closesEveryMinute(start, seam + MARGIN);
    const { stream, flush, asked } = host(columns);
    const history = new AbsorptionHistory(stream);
    history.setRules(RULES, ROW, MINUTE);
    history.want(seam - 3 * DAY, seam, seam, 3 * DAY, null, bars(closes.filter((close) => close.ts > C - 2 * DAY - HISTORY_WARMUP_MS), C - 2 * DAY - HISTORY_WARMUP_MS));
    flush();
    expect([history.running, history.status().loading]).toEqual([false, false]);
    expect(Math.min(...asked.map((request) => request.fromTs))).toBe(C - 2 * DAY - HISTORY_WARMUP_MS);
    expect(shape(history.records)).toEqual(shape(blockReference(columns, closes, C - 2 * DAY, seam)));
    expect([history.covers(C - 2 * DAY), history.covers(C - 2 * DAY - 1)]).toEqual([true, false]);
    history.want(seam - 3 * DAY, seam, seam, 3 * DAY, null, bars(closes, start));
    expect(history.status().loading).toBe(true);
    flush();
    expect(shape(history.records)).toEqual(shape(blockReference(columns, closes, seam - 3 * DAY, seam)));
  });

  it("loads from the past to the live book: the oldest day first", () => {
    const seam = C + 6 * H;
    const start = C - 3 * DAY - HISTORY_WARMUP_MS;
    const columns = columnsOver(start, seam + MARGIN, scene(attackAt(seam - 3 * H)));
    const closes = closesEveryMinute(start, seam + MARGIN);
    const { stream, flush, asked } = host(columns);
    const history = new AbsorptionHistory(stream);
    history.setRules(RULES, ROW, MINUTE);
    history.want(seam - 3 * DAY, seam, seam, 3 * DAY, null, bars(closes, start));
    flush();
    const days = asked.map((request) => Math.floor((request.fromTs + HISTORY_WARMUP_MS) / DAY) * DAY);
    const firstSeen = [...new Set(days)];
    expect(firstSeen).toEqual([...firstSeen].sort((a, b) => a - b));
    expect(firstSeen).toHaveLength(4);
  });

  it("carries the newest day on when the live book moves into a new hour: it asks for the new hour, not the day again, and the spheres are the day's", () => {
    const seam = C + 2 * H + 30 * MINUTE;
    const later = seam + H;
    const start = C - DAY - HISTORY_WARMUP_MS;
    const columns = columnsOver(start, later + MARGIN, scene(attackAt(C - 5 * H), attackAt(C + 20 * MINUTE), attackAt(C + 2 * H + 10 * MINUTE), attackAt(C + 3 * H + 5 * MINUTE)));
    const closes = closesEveryMinute(start, later + MARGIN);
    const { stream, flush, asked } = host(columns);
    const history = new AbsorptionHistory(stream);
    history.setRules(RULES, ROW, MINUTE);
    history.want(seam - DAY, seam, seam, DAY, null, bars(closes, start));
    flush();
    expect(shape(history.records)).toEqual(shape(blockReference(columns, closes, seam - DAY, seam)));
    const before = asked.length;
    history.want(later - DAY, later, later, DAY, null, bars(closes, start));
    expect(history.status().loading).toBe(false);
    flush();
    const again = asked.slice(before);
    expect(again.length).toBeGreaterThan(0);
    expect(again.length).toBeLessThanOrEqual(4);
    expect(again.every((request) => request.toTs - request.fromTs <= 2 * H)).toBe(true);
    expect(Math.min(...again.map((request) => request.fromTs))).toBeGreaterThanOrEqual(C + 2 * H);
    expect(shape(history.records)).toEqual(shape(blockReference(columns, closes, later - DAY, later)));
    expect([history.covers(later - 1), history.covers(seam - DAY)]).toEqual([true, false]);
    expect(history.covers(seam)).toBe(false);
  });

  it("asks for four hours at a time, so the host's pages come in side by side", () => {
    const seam = C + 6 * H;
    const start = C - HISTORY_WARMUP_MS;
    const columns = columnsOver(start, seam + MARGIN, scene(attackAt(C + 20 * MINUTE)));
    const closes = closesEveryMinute(start, seam + MARGIN);
    const { stream, asked, pending } = host(columns);
    const history = new AbsorptionHistory(stream);
    history.setRules(RULES, ROW, MINUTE);
    history.want(C, seam, seam, DAY, null, bars(closes, start));
    expect(new Set(asked.map((request) => request.fromTs)).size).toBe(4);
    expect(pending()).toBe(4);
  });

  it("survives a reload: a loader given the same store shows the reach at once, asks only for the hours it lacks, and another timeframe sees none of it", () => {
    const seam = C + 2 * H + 30 * MINUTE;
    const start = C - DAY - HISTORY_WARMUP_MS;
    const columns = columnsOver(start, seam + 2 * H + MARGIN, scene(attackAt(C - 5 * H), attackAt(C + 20 * MINUTE), attackAt(C + 2 * H + 10 * MINUTE), attackAt(C + 3 * H + 5 * MINUTE)));
    const closes = closesEveryMinute(start, seam + 2 * H + MARGIN);
    const items = new Map<string, string>();
    const storage = { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); }, removeItem: (key: string) => { items.delete(key); } };
    const first = host(columns);
    const history = new AbsorptionHistory(first.stream, new AbsorptionHistoryStore(storage));
    history.setRules(RULES, ROW, MINUTE);
    history.want(seam - DAY, seam, seam, DAY, null, bars(closes, start));
    first.flush();
    const day = shape(history.records);
    expect(day).toEqual(shape(blockReference(columns, closes, seam - DAY, seam)));
    expect(items.size).toBe(1);

    const second = host(columns);
    const reloaded = new AbsorptionHistory(second.stream, new AbsorptionHistoryStore(storage));
    reloaded.setRules(RULES, ROW, MINUTE);
    expect(shape(reloaded.records)).toEqual(day);
    reloaded.want(seam - DAY, seam, seam, DAY, null, bars(closes, start));
    expect([shape(reloaded.records), reloaded.status().loading, reloaded.running, second.asked.length]).toEqual([day, false, false, 0]);
    expect([reloaded.covers(seam - 1), reloaded.covers(seam - DAY)]).toEqual([true, true]);
    const later = seam + 2 * H;
    reloaded.want(later - DAY, later, later, DAY, null, bars(closes, start));
    expect(shape(reloaded.records)).toEqual(day);
    expect(reloaded.status().loading).toBe(false);
    second.flush();
    expect(shape(reloaded.records)).toEqual(shape(blockReference(columns, closes, later - DAY, later)));

    const other = new AbsorptionHistory(host(columns).stream, new AbsorptionHistoryStore(storage));
    other.setRules(RULES, ROW, 15 * MINUTE);
    expect(other.records).toEqual([]);
  });

  it("saves what an hour's records became by the end of the run: an attack still growing after its hour was judged reloads with its later trail entry and its newest reading", () => {
    // The hour is judged at 3h, once the run has read two quiet minutes past the seam; the run reads on three more minutes,
    // where a hit at 3h01 makes the attack strong and meets a new number. A lot of 1 every 100 s keeps the attack going until then.
    const seam = C + 2 * H + 30 * MINUTE;
    const attack = C + 2 * H + 20 * MINUTE;
    const late = C + 3 * H + MINUTE;
    const spec = (ts: number): Col => {
      if (ts < attack - 5 * MINUTE) return { wall: 0 };
      if (ts === attack || ts === attack + STEP) return { wall: 200, sell: 120 };
      if (ts === late) return { wall: 200, sell: 200 };
      return { wall: 200, sell: ts > attack + STEP && ts < late && (ts - attack - STEP) % 100_000 === 0 ? 1 : 0 };
    };
    const start = C - HISTORY_WARMUP_MS;
    const columns = columnsOver(start, C + 4 * H, spec);
    const closes = closesEveryMinute(start, C + 4 * H);
    const grown = reference(columns, closes, C, seam);
    expect(grown.map((record) => [record.ts, record.trail[record.trail.length - 1].ts, record.latest.ts, record.latest.absorbed])).toEqual([[attack + STEP, late, late, 464]]);
    const prints = (records: readonly AbsorptionRecord[]) => [read(records)[0]?.strong, read(records, { ...RULES, absorbedPercent: 200, strongPercent: 300 })[0]?.ts];
    expect(prints(grown)).toEqual([true, late]);
    const items = new Map<string, string>();
    const storage = { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); }, removeItem: (key: string) => { items.delete(key); } };
    const first = host(columns);
    const history = new AbsorptionHistory(first.stream, new AbsorptionHistoryStore(storage));
    history.setRules(RULES, ROW, MINUTE);
    history.want(C, seam, seam, 48 * H, null, bars(closes, start));
    first.flush();
    expect([history.running, history.records]).toEqual([false, grown]);

    const second = host(columns);
    const reloaded = new AbsorptionHistory(second.stream, new AbsorptionHistoryStore(storage));
    reloaded.setRules(RULES, ROW, MINUTE);
    reloaded.want(C, seam, seam, 48 * H, null, bars(closes, start));
    expect([reloaded.running, second.asked.length]).toEqual([false, 0]);
    expect(reloaded.records).toEqual(grown);
    expect(prints(reloaded.records)).toEqual([true, late]);
  });

  it("keeps the judged day when the rule's numbers change: nothing asked, not loading, the same records read anew at once, and a run in flight carries on", () => {
    // The user's slider: every notch made the loader throw the day away and ask the host for it again (25-30 s of
    // "LOADING 1 DAY"). The three numbers and the break window read the records; they are not in the loader's key.
    const seam = C + 2 * H + 30 * MINUTE;
    const start = C - DAY - HISTORY_WARMUP_MS;
    const columns = columnsOver(start, seam + 2 * H + MARGIN, scene(attackAt(C + 20 * MINUTE), attackAt(C + 2 * H + 10 * MINUTE), attackAt(seam + H + 5 * MINUTE)));
    const closes = closesEveryMinute(start, seam + 2 * H + MARGIN);
    const { stream, flush, asked } = host(columns);
    const history = new AbsorptionHistory(stream);
    history.setRules(RULES, ROW, MINUTE);
    history.want(seam - DAY, seam, seam, DAY, null, bars(closes, start));
    flush();
    const day = shape(history.records);
    expect(day).toEqual(shape(blockReference(columns, closes, seam - DAY, seam)));
    expect(history.records).toHaveLength(2);
    const count = asked.length;
    const stricter: AbsorptionRules = { ...RULES, absorbedPercent: 300, strongPercent: 500, absorbedMultiple: 20, breakWindowMs: 60_000 };
    history.setRules(stricter, ROW, MINUTE);
    expect([shape(history.records), history.covers(seam - 1), history.status().loading, history.running]).toEqual([day, true, false, false]);
    history.want(seam - DAY, seam, seam, DAY, null, bars(closes, start));
    expect([shape(history.records), history.status().loading, history.running, asked.length]).toEqual([day, false, false, count]);
    expect(read(history.records, stricter)).toEqual([null, null]);
    expect(read(history.records).map((print) => print?.share)).toEqual([1, 1]);
    // The live book moves into a new hour: the run for it is in flight when the numbers change again, and carries on,
    // asking the host exactly what a loader whose numbers never changed asks.
    const later = seam + 2 * H;
    history.want(later - DAY, later, later, DAY, null, bars(closes, start));
    expect(history.running).toBe(true);
    const inFlight = asked.length;
    expect(inFlight).toBeGreaterThan(count);
    history.setRules({ ...stricter, absorbedPercent: 150 }, ROW, MINUTE);
    expect([history.running, asked.length]).toEqual([true, inFlight]);
    flush();
    expect(history.running).toBe(false);
    expect(shape(history.records)).toEqual(shape(blockReference(columns, closes, later - DAY, later)));
    expect(history.records).toHaveLength(3);
    const control = host(columns);
    const steady = new AbsorptionHistory(control.stream);
    steady.setRules(RULES, ROW, MINUTE);
    steady.want(seam - DAY, seam, seam, DAY, null, bars(closes, start));
    control.flush();
    steady.want(seam - DAY, seam, seam, DAY, null, bars(closes, start));
    steady.want(later - DAY, later, later, DAY, null, bars(closes, start));
    control.flush();
    expect(asked.map((request) => request.fromTs)).toEqual(control.asked.map((request) => request.fromTs));
    expect(shape(steady.records)).toEqual(shape(history.records));
  });

  it("tells its listeners nothing when asked again for the same stretch", () => {
    const seam = C + 2 * H;
    const start = C - HISTORY_WARMUP_MS;
    const columns = columnsOver(start, seam + MARGIN, scene(attackAt(C + 20 * MINUTE)));
    const closes = closesEveryMinute(start, seam + MARGIN);
    const { stream, flush } = host(columns);
    const history = new AbsorptionHistory(stream);
    history.setRules(RULES, ROW, MINUTE);
    let told = 0;
    history.subscribe(() => { told += 1; });
    history.want(C, seam, seam, DAY, null, bars(closes, start));
    flush();
    const settled = told;
    history.want(C, seam, seam, DAY, null, bars(closes, start));
    history.want(C, seam + 10_000, seam + 10_000, DAY, null, bars(closes, start));
    expect(told).toBe(settled);
  });

  it("stops at a page in another row width, and forgets it all on new rules", () => {
    const columns = columnsOver(C - 8 * H, C + 2 * H + MARGIN, scene(attackAt(C + 20 * MINUTE)));
    const closes = closesEveryMinute(C - 8 * H, C + 2 * H + MARGIN);
    const { stream, flush } = host(columns, ROW * 2);
    const history = new AbsorptionHistory(stream);
    history.setRules(RULES, ROW, MINUTE);
    history.want(C, C + H, C + H, 48 * H, null, bars(closes, C - 8 * H));
    flush();
    expect(history.running).toBe(false);
    expect(history.records).toEqual([]);
    history.want(C, C + H, C + H, 48 * H, null, bars(closes, C - 8 * H));
    expect(history.running).toBe(false);
    history.setRules({ ...RULES, bandRows: 8 }, ROW, MINUTE);
    history.want(C, C + H, C + H, 48 * H, null, bars(closes, C - 8 * H));
    expect(history.running).toBe(true);
  });

  it("keys the judged hours on the walls: another quiet spell or wall floor asks the host again; the three numbers, the break window or other functions do not", () => {
    const columns = columnsOver(C - 8 * H, C + 2 * H + MARGIN, scene(attackAt(C + 20 * MINUTE)));
    const closes = closesEveryMinute(C - 8 * H, C + 2 * H + MARGIN);
    const { stream, flush } = host(columns);
    const history = new AbsorptionHistory(stream);
    history.setRules(RULES, ROW, MINUTE);
    history.want(C, C + H, C + H, 48 * H, null, bars(closes, C - 8 * H));
    flush();
    expect([history.running, history.records.length]).toEqual([false, 1]);
    for (const other of [{ quietMs: 130_000 }, { wallKey: "other" }]) {
      history.setRules({ ...RULES, ...other }, ROW, MINUTE);
      expect(history.records).toEqual([]);
      history.want(C, C + H, C + H, 48 * H, null, bars(closes, C - 8 * H));
      expect(history.running).toBe(true);
      flush();
    }
    for (const same of [{ absorbedPercent: 300 }, { strongPercent: 700 }, { absorbedMultiple: 60 }, { breakWindowMs: 60_000 }, { wallFloor: () => 50, bandSize: RULES.bandSize }]) {
      history.setRules({ ...RULES, ...same }, ROW, MINUTE);
      expect(history.records).toHaveLength(1);
      history.want(C, C + H, C + H, 48 * H, null, bars(closes, C - 8 * H));
      expect(history.running).toBe(false);
    }
  });

  it("reads no further back than History (hours) from the live seam, whatever the view asks", () => {
    const start = C - 3 * DAY;
    const columns = columnsOver(start, C + 4 * H + MARGIN, scene(attackAt(C - DAY + 2 * H), attackAt(C + H)));
    const closes = closesEveryMinute(start, C + 4 * H + MARGIN);
    const { stream, flush, asked } = host(columns);
    const history = new AbsorptionHistory(stream);
    history.setRules(RULES, ROW, MINUTE);
    history.want(C - 2 * DAY, C + 4 * H, C + 4 * H, 4 * H, null, bars(closes, start));
    flush();
    expect(Math.min(...asked.map((request) => request.fromTs))).toBe(C - HISTORY_WARMUP_MS);
    expect([history.covers(C + H), history.covers(C - DAY + 2 * H)]).toEqual([true, false]);
    expect(history.records.every((record) => record.ts >= C)).toBe(true);
  });
});
