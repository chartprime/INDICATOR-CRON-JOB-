import { afterEach, describe, expect, it } from "vitest";
import { columnMid } from "../../absorption-detector/absorptionColumns";
import { ColumnHistoryStream, STREAM_CHUNK_MS, STREAM_LEVEL_MS } from "../../passive-liquidity/columnHistoryStream";
import type { HistoryRequest } from "../../passive-liquidity/heatmapHistory";
import { HISTORY_WINDOW_MS, type DecodedHistoryPage } from "../../passive-liquidity/heatmapHistoryDecode";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import { liveSweeps, type SweepRules } from "../sweepModel";
import { PAST_STALE_MS, askPast, heldFrom, pastColumns, pastLoaded, pastSlotFor, replayPast, resetPastSlotsForTests, slimColumn, type PastBar } from "../voidsPast";

const H = STREAM_CHUNK_MS;
const S = 1_000;
const ROW = 4;
const T0 = 1_790_000_000_000 - (1_790_000_000_000 % H);
const BTC = { provider: "BINANCE" as const, marketKind: "PERPETUAL" as const, symbol: "BTC-USDT" };
const ID = { provider: "BINANCE" as const, marketKind: "PERPETUAL", symbol: "BTCUSDT" };
const RULES: SweepRules = { windowMs: 30_000, minMoveRows: 6 };

/** A book with two rows a side around `bidRow`, wide like the host's columns, with empty flow lists. */
function column(ts: number, bidRow: number): LiquidityColumn {
  const lo = bidRow - 40;
  const hi = bidRow + 41;
  const bid = new Float64Array(hi - lo + 1);
  const ask = new Float64Array(hi - lo + 1);
  bid[bidRow - 1 - lo] = 7;
  bid[bidRow - lo] = 5;
  ask[bidRow + 1 - lo] = 5;
  ask[bidRow + 2 - lo] = 9;
  return { ts, lo, hi, bid, ask, buy: [], sell: [] };
}

/** Two quiet minutes at row 1000, an eight-row push up over thirty seconds printing 2 per row crossed, two minutes held. The trades that moved price into a column sit on the column before it. */
function push(from: number): LiquidityColumn[] {
  const out: LiquidityColumn[] = [];
  let ts = from;
  for (let i = 0; i < 120; i += 1, ts += S) out.push(column(ts, 1000));
  let previous = 1000;
  for (let i = 1; i <= 30; i += 1, ts += S) {
    const row = 1000 + Math.round((8 * i) / 30);
    const crossed: [number, number][] = [];
    for (let r = previous + 1; r <= row; r += 1) crossed.push([r, 2]);
    const before = out[out.length - 1];
    before.buy = [...(before.buy ?? []), ...crossed];
    out.push(column(ts, row));
    previous = row;
  }
  for (let i = 0; i < 120; i += 1, ts += S) out.push(column(ts, 1008));
  return out;
}

function quiet(from: number, to: number, row = 1000): LiquidityColumn[] {
  const out: LiquidityColumn[] = [];
  for (let ts = from; ts < to; ts += STREAM_LEVEL_MS) out.push(column(ts, row));
  return out;
}

function pageOf(request: HistoryRequest, columns: readonly LiquidityColumn[], rowWidth = ROW): DecodedHistoryPage {
  const byWindow = new Map<number, LiquidityColumn[]>();
  for (const c of columns) {
    if (c.ts < request.fromTs || c.ts >= request.toTs) continue;
    const ts = Math.floor(c.ts / HISTORY_WINDOW_MS) * HISTORY_WINDOW_MS;
    const list = byWindow.get(ts) ?? [];
    list.push(c);
    byWindow.set(ts, list);
  }
  const windows = [...byWindow.entries()].sort((a, b) => a[0] - b[0]).map(([ts, list]) => ({ ts, state: "COVERED" as const, columns: list }));
  return { available: true, generation: "g", levelMs: STREAM_LEVEL_MS, rowFactor: 1, rowWidth, span: { oldest: null, newest: null }, next: null, windows };
}

function lane() {
  const sent: HistoryRequest[] = [];
  const stream = new ColumnHistoryStream({ request: (request) => sent.push(request), maxInFlight: 2 });
  stream.setIdentity(ID);
  return { stream, sent };
}

function bars(from: number, closes: readonly (number | null)[]): PastBar[] {
  return closes.map((close, i) => ({ open: from + i * 60 * S, close: close === null ? null : close * ROW }));
}

afterEach(() => {
  resetPastSlotsForTests();
});

describe("liquidity voids past: the host's columns kept slim, replayed candle by candle", () => {
  it("keeps only the touch and the traded flow of a column, so the model reads the same mid from a fraction of the rows; a book with one side keeps that side, an empty book is dropped", () => {
    const full = column(T0, 1000);
    full.buy = [[1001, 3]];
    full.sell = [[1000, 1]];
    const slim = slimColumn(full);
    expect(slim).not.toBeNull();
    expect([slim?.lo, slim?.hi, Array.from(slim?.bid ?? []), Array.from(slim?.ask ?? [])]).toEqual([1000, 1001, [5, 0], [0, 5]]);
    expect(columnMid(slim as LiquidityColumn, ROW)).toBe(columnMid(full, ROW));
    expect([slim?.buy, slim?.sell]).toEqual([full.buy, full.sell]);
    const bidOnly = column(T0, 1000);
    bidOnly.ask.fill(0);
    delete bidOnly.buy;
    delete bidOnly.sell;
    const oneSide = slimColumn(bidOnly) as LiquidityColumn;
    expect([oneSide.lo, oneSide.hi, "buy" in oneSide, "sell" in oneSide]).toEqual([1000, 1000, false, false]);
    expect(columnMid(oneSide, ROW)).toBe(columnMid(bidOnly, ROW));
    const empty = column(T0, 1000);
    empty.bid.fill(0);
    empty.ask.fill(0);
    expect(slimColumn(empty)).toBeNull();
  });

  it("stores an hour when its chunk finishes, covered up to the seam it was asked to, drops a failed chunk and the columns of another row width, and hands the hours back in time order inside the asked span", () => {
    const { stream, sent } = lane();
    const slot = pastSlotFor(BTC, ROW);
    const seam = T0 + 2 * H + 20 * 60 * S;
    askPast(slot, stream, seam - 2 * H, seam);
    expect(sent.map((r) => [r.fromTs, r.toTs])).toEqual([[T0 + 2 * H, seam], [T0 + H, T0 + 2 * H]]);
    const older = quiet(T0 + H, T0 + 2 * H);
    stream.accept(sent[1].requestId, pageOf(sent[1], older));
    expect(slot.version).toBe(1);
    expect(slot.hours.get(T0 + H)?.coveredTo).toBe(T0 + 2 * H);
    stream.accept(sent[0].requestId, pageOf(sent[0], quiet(T0 + 2 * H, seam), ROW * 2));
    expect([slot.hours.get(T0 + 2 * H)?.columns, slot.hours.get(T0 + 2 * H)?.coveredTo]).toEqual([[], seam]);
    expect(sent).toHaveLength(3);
    stream.fail(sent[2].requestId);
    expect(slot.hours.has(T0)).toBe(false);
    const all = pastColumns(slot, T0, seam);
    expect(all.columns.map((c) => c.ts)).toEqual(older.map((c) => c.ts));
    expect(all.columns.every((c) => c.bid.length === 2)).toBe(true);
    expect(all.end).toBe(seam);
    expect(pastColumns(slot, T0 + H + 30 * 60 * S, T0 + H + 40 * 60 * S).columns).toHaveLength(60);
    expect(pastColumns(slot, T0, T0 + H + 40 * 60 * S).end).toBe(T0 + H + 40 * 60 * S);
    expect(pastSlotFor(BTC, ROW)).toBe(slot);
    expect(pastSlotFor(BTC, ROW * 2)).not.toBe(slot);
  });

  it("asks an hour again once the seam has moved ten minutes past where that hour stopped, once, and tells a new lane which hours it already holds", () => {
    const { stream, sent } = lane();
    const slot = pastSlotFor(BTC, ROW);
    const seam = T0 + 2 * H + 20 * 60 * S;
    askPast(slot, stream, seam - H, seam);
    stream.accept(sent[0].requestId, pageOf(sent[0], []));
    stream.accept(sent[1].requestId, pageOf(sent[1], []));
    expect(slot.hours.get(T0 + 2 * H)?.coveredTo).toBe(seam);
    expect(sent).toHaveLength(2);
    askPast(slot, stream, seam + 5 * 60 * S - H, seam + 5 * 60 * S);
    expect(sent).toHaveLength(2);
    const later = seam + PAST_STALE_MS + S;
    askPast(slot, stream, later - H, later);
    expect(sent.slice(2).map((r) => [r.fromTs, r.toTs])).toEqual([[T0 + 2 * H, later]]);
    askPast(slot, stream, later - H, later);
    expect(sent).toHaveLength(3);
    stream.accept(sent[2].requestId, pageOf(sent[2], []));
    expect(slot.hours.get(T0 + 2 * H)?.coveredTo).toBe(later);
    const other = lane();
    askPast(slot, other.stream, later - 2 * H, later);
    expect(other.sent.map((r) => r.fromTs)).toEqual([T0]);
    const version = slot.version;
    stream.reset();
    stream.want(later - H, later, 0, 0);
    stream.accept(sent[3].requestId, pageOf(sent[3], quiet(T0 + 2 * H, later)));
    expect([sent[3].fromTs, slot.hours.get(T0 + 2 * H)?.columns, slot.version]).toEqual([T0 + 2 * H, [], version]);
  });

  it("knows when every asked hour has arrived or failed, so the learned rule can wait for the whole stretch, and forgets a failure once the hour arrives", () => {
    const { stream, sent } = lane();
    const slot = pastSlotFor(BTC, ROW);
    const seam = T0 + 3 * H;
    askPast(slot, stream, T0, seam);
    expect(pastLoaded(slot, T0, seam)).toBe(false);
    expect(sent.map((r) => r.fromTs)).toEqual([T0 + 2 * H, T0 + H]);
    stream.accept(sent[0].requestId, pageOf(sent[0], []));
    stream.accept(sent[1].requestId, pageOf(sent[1], []));
    expect(sent).toHaveLength(3);
    expect(pastLoaded(slot, T0, seam)).toBe(false);
    stream.fail(sent[2].requestId);
    expect(pastLoaded(slot, T0, seam)).toBe(true);
    expect(pastLoaded(slot, T0 + H, seam)).toBe(true);
    expect(pastLoaded(slot, T0, T0)).toBe(true);
    const version = slot.version;
    stream.reset([T0 + H, T0 + 2 * H]);
    stream.want(T0, seam, 0, 0);
    expect(sent[3].fromTs).toBe(T0);
    stream.accept(sent[3].requestId, pageOf(sent[3], []));
    expect([slot.failed.has(T0), slot.version, pastLoaded(slot, T0, seam)]).toEqual([false, version + 1, true]);
    expect(pastLoaded(slot, T0 + 17 * 60 * S, seam)).toBe(true);
    expect(pastLoaded(slot, T0 - 17 * 60 * S, seam)).toBe(false);
  });

  it("finds where the newest unbroken stretch of held hours starts: it stops at an hour still to come or one that failed, never reaches before the asked hour, starts at its oldest hour with a column, and gives the seam itself when the newest hour is missing or the stretch holds no column before the seam (#46 review)", () => {
    const slot = pastSlotFor(BTC, ROW);
    const seam = T0 + 3 * H + 10 * 60 * S;
    const hold = (into: typeof slot, start: number, columns: LiquidityColumn[]) => into.hours.set(start, { columns, coveredTo: Math.min(start + H, seam) });
    expect(heldFrom(slot, T0, seam)).toBe(seam);
    hold(slot, T0 + 3 * H, quiet(T0 + 3 * H, seam));
    expect(heldFrom(slot, T0, seam)).toBe(T0 + 3 * H);
    hold(slot, T0 + 2 * H, quiet(T0 + 2 * H, T0 + 3 * H));
    hold(slot, T0, quiet(T0, T0 + H));
    expect(heldFrom(slot, T0, seam)).toBe(T0 + 2 * H);
    slot.failed.add(T0 + H);
    expect(heldFrom(slot, T0, seam)).toBe(T0 + 2 * H);
    hold(slot, T0 + H, []);
    expect(heldFrom(slot, T0 + 17 * 60 * S, seam)).toBe(T0);
    expect(heldFrom(slot, T0 + H, seam)).toBe(T0 + 2 * H);
    const empty = pastSlotFor({ ...BTC, symbol: "ETH-USDT" }, ROW);
    hold(empty, T0 + 3 * H, quiet(seam, seam + 60 * S));
    hold(empty, T0 + 2 * H, []);
    expect(heldFrom(empty, T0, seam)).toBe(seam);
    hold(empty, T0 + H, quiet(T0 + H, T0 + 2 * H));
    expect(heldFrom(empty, T0, seam)).toBe(T0 + H);
  });

  it("forgets the hours that failed on one lane when it binds to another, so a new lane's unanswered hours still count as loading", () => {
    const first = lane();
    const slot = pastSlotFor(BTC, ROW);
    const seam = T0 + 2 * H;
    askPast(slot, first.stream, T0, seam);
    first.stream.accept(first.sent[0].requestId, pageOf(first.sent[0], []));
    first.stream.fail(first.sent[1].requestId);
    expect(pastLoaded(slot, T0, seam)).toBe(true);
    const second = lane();
    askPast(slot, second.stream, T0, seam);
    expect(pastLoaded(slot, T0, seam)).toBe(false);
    expect(second.sent.map((r) => r.fromTs)).toEqual([T0]);
    second.stream.accept(second.sent[0].requestId, pageOf(second.sent[0], []));
    expect(pastLoaded(slot, T0, seam)).toBe(true);
  });

  it("replays columns and candle closes in time order: a push older than the chart's own columns is a box with its volume, the same from slim columns as from whole ones; a later close through it mitigates it, an earlier one does not", () => {
    const whole = push(T0);
    const slim = whole.map((c) => slimColumn(c) as LiquidityColumn);
    const held = bars(T0, [1000, 1000, 1008, 1008, 1008]);
    const fromWhole = liveSweeps(replayPast(whole, held, 60 * S, RULES, ROW));
    const fromSlim = liveSweeps(replayPast(slim, held, 60 * S, RULES, ROW));
    expect(fromSlim).toHaveLength(1);
    expect(fromSlim[0]).toMatchObject({ side: "ask", rowLo: 1001, rowHi: 1008 });
    expect(fromSlim[0].volume).toBe(16);
    expect(fromSlim.map((b) => [b.side, b.rowLo, b.rowHi, b.startTs, b.endTs, b.volume])).toEqual(fromWhole.map((b) => [b.side, b.rowLo, b.rowHi, b.startTs, b.endTs, b.volume]));
    expect(liveSweeps(replayPast(slim, bars(T0, [1000, 1000, 1008, 998, 998]), 60 * S, RULES, ROW))).toHaveLength(0);
    expect(liveSweeps(replayPast(slim, bars(T0, [990, 1000, 1008, 1008, null]), 60 * S, RULES, ROW))).toHaveLength(1);
    expect(liveSweeps(replayPast(slim, [], 60 * S, RULES, ROW))).toHaveLength(1);
  });
});
