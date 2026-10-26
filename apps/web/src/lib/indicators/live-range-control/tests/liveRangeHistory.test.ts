import { afterEach, describe, expect, it, vi } from "vitest";
import { ColumnHistoryStream, STREAM_CHUNK_MS, STREAM_LEVEL_MS } from "../../passive-liquidity/columnHistoryStream";
import type { HistoryRequest } from "../../passive-liquidity/heatmapHistory";
import { HISTORY_WINDOW_MS, type DecodedHistoryPage } from "../../passive-liquidity/heatmapHistoryDecode";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import { HISTORY_RETRY_MS, KEEP_PAD_MIN_MS, LiveRangeHistory, STALE_CHUNK_MS, forkForLiveRange, hostColumnOf } from "../liveRangeHistory";

const T = Date.UTC(2026, 9, 16, 2, 0);
const MINUTE = 60_000;
const BTC = { provider: "BINANCE" as const, marketKind: "SPOT", symbol: "BTC-USDT" };
const ETH = { provider: "BINANCE" as const, marketKind: "PERPETUAL", symbol: "ETH-USDT" };

function column(ts: number, buy = 0, sell = 0): LiquidityColumn {
  return { ts, lo: 99, hi: 101, bid: Float64Array.from([7, 0, 0]), ask: Float64Array.from([0, 7, 0]), ...(buy > 0 ? { buy: [[100, buy]] as const } : {}), ...(sell > 0 ? { sell: [[101, sell]] as const } : {}) };
}

function page(request: HistoryRequest, columns: readonly LiquidityColumn[], rowWidth = 1, next: number | null = null): DecodedHistoryPage {
  const byWindow = new Map<number, LiquidityColumn[]>();
  for (const c of columns) {
    if (c.ts < request.fromTs || c.ts >= request.toTs) continue;
    const ts = Math.floor(c.ts / HISTORY_WINDOW_MS) * HISTORY_WINDOW_MS;
    byWindow.set(ts, [...(byWindow.get(ts) ?? []), c]);
  }
  const windows = [...byWindow.entries()].sort((a, b) => a[0] - b[0]).map(([ts, list]) => ({ ts, state: "COVERED" as const, columns: list }));
  return { available: true, generation: "g", levelMs: STREAM_LEVEL_MS, rowFactor: 1, rowWidth, span: { oldest: null, newest: null }, next, windows };
}

function harness() {
  const sent: HistoryRequest[] = [];
  const stream = new ColumnHistoryStream({ request: (request) => sent.push(request), maxPerMinute: 100_000, retryMs: 1 });
  stream.setIdentity(BTC);
  const changed = vi.fn();
  const history = new LiveRangeHistory(stream, changed);
  return { sent, stream, changed, history };
}

const stamps = (history: LiveRangeHistory, fromTs: number, beforeTs: number) => history.columns(fromTs, beforeTs).map((c) => c.ts);

afterEach(() => {
  vi.useRealTimers();
});

describe("LiveRangeHistory", () => {
  it("asks the host for the window before the runtime's columns in hour chunks, keeps each column's trade rows and row width as it lands, never its book, and says so once per page that brought something and once more as each hour completes", () => {
    const { sent, stream, changed, history } = harness();
    const from = T + 10 * MINUTE;
    const before = T + 2 * STREAM_CHUNK_MS + 20 * MINUTE;
    history.want(from, before);
    expect(sent.map((r) => [r.fromTs, r.toTs, r.levelMs])).toEqual([
      [T + 2 * STREAM_CHUNK_MS, before, STREAM_LEVEL_MS],
      [T + STREAM_CHUNK_MS, T + 2 * STREAM_CHUNK_MS, STREAM_LEVEL_MS],
      [T, T + STREAM_CHUNK_MS, STREAM_LEVEL_MS],
    ]);
    expect(history.columns(from, before)).toEqual([]);
    stream.accept(sent[2].requestId, page(sent[2], [column(T + 5 * MINUTE, 2), column(T + 20 * MINUTE, 1, 3)]));
    expect(changed).toHaveBeenCalledTimes(2);
    const trades = (c: { ts: number; rowWidth: number; buy: unknown; sell: unknown }) => ({ ts: c.ts, rowWidth: c.rowWidth, buy: c.buy, sell: c.sell });
    expect(history.columns(from, before).map(trades)).toEqual([{ ts: T + 20 * MINUTE, rowWidth: 1, buy: [[100, 1]], sell: [[101, 3]] }]);
    expect(trades(history.columns(T, before)[0])).toEqual({ ts: T + 5 * MINUTE, rowWidth: 1, buy: [[100, 2]], sell: [] });
    stream.accept(sent[0].requestId, page(sent[0], [column(T + 2 * STREAM_CHUNK_MS + 10 * MINUTE)], 2));
    stream.accept(sent[1].requestId, page(sent[1], [column(T + STREAM_CHUNK_MS + 30 * MINUTE)]));
    expect(changed).toHaveBeenCalledTimes(6);
    expect(stamps(history, from, before)).toEqual([T + 20 * MINUTE, T + STREAM_CHUNK_MS + 30 * MINUTE, T + 2 * STREAM_CHUNK_MS + 10 * MINUTE]);
    expect(history.columns(from, before).map((c) => c.rowWidth)).toEqual([1, 1, 2]);
    expect(stamps(history, T + STREAM_CHUNK_MS, T + 2 * STREAM_CHUNK_MS)).toEqual([T + STREAM_CHUNK_MS + 30 * MINUTE]);
    expect(stamps(history, T + 20 * MINUTE, T + 20 * MINUTE)).toEqual([]);
    expect(history.covered(T, before)).toBe(true);
  });

  it("asks nothing again while the window moves over hours it holds, and only the hours it never held when the window reaches further back", () => {
    const { sent, stream, history } = harness();
    const before = T + 2 * STREAM_CHUNK_MS;
    history.want(T + 30 * MINUTE, before);
    expect(sent).toHaveLength(2);
    stream.accept(sent[0].requestId, page(sent[0], [column(T + STREAM_CHUNK_MS + MINUTE, 1)]));
    stream.accept(sent[1].requestId, page(sent[1], [column(T + 40 * MINUTE, 2)]));
    history.want(T + 50 * MINUTE, before);
    history.want(T + 35 * MINUTE, before - 20 * MINUTE);
    history.want(T + 30 * MINUTE, before);
    expect(sent).toHaveLength(2);
    history.want(T - 30 * MINUTE, before);
    expect(sent).toHaveLength(3);
    expect([sent[2].fromTs, sent[2].toTs]).toEqual([T - STREAM_CHUNK_MS, T]);
    history.want(T, T);
    history.want(T, T - MINUTE);
    expect(sent).toHaveLength(3);
  });

  it("asks an hour again once the window reaches more than a minute past what it held of it, keeping the columns it has and adding only the newer ones", () => {
    const { sent, stream, changed, history } = harness();
    let before = T + 20 * MINUTE;
    history.want(T, before);
    stream.accept(sent[0].requestId, page(sent[0], [column(T + 5 * MINUTE, 1), column(T + 15 * MINUTE, 2)]));
    expect(history.covered(T, before)).toBe(true);
    before += STALE_CHUNK_MS;
    history.want(T, before);
    expect(sent).toHaveLength(1);
    before += 1;
    history.want(T, before);
    expect(sent).toHaveLength(2);
    expect([sent[1].fromTs, sent[1].toTs]).toEqual([T, before]);
    expect(history.covered(T, before)).toBe(false);
    stream.accept(sent[1].requestId, page(sent[1], [column(T + 5 * MINUTE, 1), column(T + 15 * MINUTE, 2), column(T + 20 * MINUTE + 30_000, 4)]));
    expect(stamps(history, T, before)).toEqual([T + 5 * MINUTE, T + 15 * MINUTE, T + 20 * MINUTE + 30_000]);
    expect(changed).toHaveBeenCalledTimes(4);
    expect(history.covered(T, before)).toBe(true);
    expect(STALE_CHUNK_MS).toBe(60_000);
  });

  it("says a range is covered once every hour chunk it needs is done, before any landed it is not, and a range that needs no hour is", () => {
    const { sent, stream, history } = harness();
    const before = T + 2 * STREAM_CHUNK_MS + 20 * MINUTE;
    expect(history.covered(T, T)).toBe(true);
    expect(history.covered(T + 30 * MINUTE, T + 10 * MINUTE)).toBe(true);
    history.want(T + 10 * MINUTE, before);
    expect(history.covered(T + 10 * MINUTE, before)).toBe(false);
    const at = (start: number) => sent.find((r) => r.fromTs === start)!;
    stream.accept(at(T + 2 * STREAM_CHUNK_MS).requestId, page(at(T + 2 * STREAM_CHUNK_MS), [column(T + 2 * STREAM_CHUNK_MS + 5 * MINUTE, 1)]));
    expect(history.covered(T + 10 * MINUTE, before)).toBe(false);
    expect(history.covered(T + 2 * STREAM_CHUNK_MS, before)).toBe(true);
    stream.accept(at(T).requestId, page(at(T), []));
    expect(history.covered(T + 10 * MINUTE, before)).toBe(false);
    stream.accept(at(T + STREAM_CHUNK_MS).requestId, page(at(T + STREAM_CHUNK_MS), []));
    expect(history.covered(T + 10 * MINUTE, before)).toBe(true);
    expect(history.covered(T - MINUTE, before)).toBe(false);
    expect(history.covered(T + 10 * MINUTE, before + STREAM_CHUNK_MS)).toBe(false);
  });

  it("leaves an hour it held alone while the window lies wholly after it, however little of the hour it held", () => {
    const { sent, stream, history } = harness();
    history.want(T, T + 20 * MINUTE);
    stream.accept(sent[0].requestId, page(sent[0], [column(T + 5 * MINUTE, 1)]));
    expect(history.covered(T, T + 20 * MINUTE)).toBe(true);
    history.want(T + 2 * STREAM_CHUNK_MS, T + 2 * STREAM_CHUNK_MS + 10 * MINUTE);
    expect(history.covered(T, T + 20 * MINUTE)).toBe(true);
  });

  it("asks its hours oldest first when told so, and newest first again on a later ask without it", () => {
    const { sent, stream, history } = harness();
    const before = T + 3 * STREAM_CHUNK_MS;
    history.want(T, before, true);
    expect(sent.map((r) => r.fromTs)).toEqual([T, T + STREAM_CHUNK_MS, T + 2 * STREAM_CHUNK_MS].slice(0, sent.length));
    for (const request of [...sent]) stream.accept(request.requestId, page(request, []));
    history.want(T - 2 * STREAM_CHUNK_MS, before);
    expect(sent.slice(3).map((r) => r.fromTs)).toEqual([T - STREAM_CHUNK_MS, T - 2 * STREAM_CHUNK_MS].slice(0, sent.length - 3));
  });

  it("starts over when the stream moves to another instrument, and a page of the old one is not kept", () => {
    const { sent, stream, history } = harness();
    history.want(T, T + 30 * MINUTE);
    stream.accept(sent[0].requestId, page(sent[0], [column(T + MINUTE, 4)]));
    expect(history.columns(T, T + 30 * MINUTE)).toHaveLength(1);
    stream.setIdentity(ETH);
    history.want(T, T + 30 * MINUTE);
    expect(history.columns(T, T + 30 * MINUTE)).toEqual([]);
    expect(sent).toHaveLength(2);
    expect(history.covered(T, T + 30 * MINUTE)).toBe(false);
  });

  it("a chunk the host could not give is not covered and is asked for again later, and a chunk that landed is not asked twice", () => {
    vi.useFakeTimers();
    const { sent, stream, history } = harness();
    history.want(T, T + 30 * MINUTE);
    stream.accept(sent[0].requestId, { available: false, reason: "UNAVAILABLE" });
    expect(history.covered(T, T + 30 * MINUTE)).toBe(false);
    vi.advanceTimersByTime(5);
    history.want(T, T + 30 * MINUTE);
    expect(sent).toHaveLength(2);
    stream.accept(sent[1].requestId, page(sent[1], [column(T + MINUTE, 4)]));
    expect(history.covered(T, T + 30 * MINUTE)).toBe(true);
    history.want(T, T + 30 * MINUTE);
    expect(sent).toHaveLength(2);
  });

  it("keeps the pages a chunk has already brought when a later page of it fails, counts them at once, asks the chunk again without doubling what it holds, and calls the chunk covered only once it is whole", () => {
    vi.useFakeTimers();
    const { sent, stream, changed, history } = harness();
    const before = T + 50 * MINUTE;
    history.want(T, before);
    expect(sent).toHaveLength(1);
    const early = [column(T + 5 * MINUTE, 2), column(T + 20 * MINUTE, 1)];
    stream.accept(sent[0].requestId, page(sent[0], early, 1, T + 30 * MINUTE));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(stamps(history, T, before)).toEqual([T + 5 * MINUTE, T + 20 * MINUTE]);
    expect(history.covered(T, before)).toBe(false);
    expect(sent).toHaveLength(2);
    expect([sent[1].fromTs, sent[1].toTs]).toEqual([T + 30 * MINUTE, before]);
    stream.fail(sent[1].requestId);
    expect(stamps(history, T, before)).toEqual([T + 5 * MINUTE, T + 20 * MINUTE]);
    expect(history.covered(T, before)).toBe(false);
    vi.advanceTimersByTime(5);
    history.want(T, before);
    expect(sent).toHaveLength(3);
    expect([sent[2].fromTs, sent[2].toTs]).toEqual([T, before]);
    stream.accept(sent[2].requestId, page(sent[2], early, 1, T + 30 * MINUTE));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(history.columns(T, before)).toHaveLength(2);
    expect(sent).toHaveLength(4);
    stream.accept(sent[3].requestId, page(sent[3], [column(T + 40 * MINUTE, 5)]));
    expect(changed).toHaveBeenCalledTimes(3);
    expect(history.columns(T, before).map((c) => [c.ts, c.buy])).toEqual([[T + 5 * MINUTE, [[100, 2]]], [T + 20 * MINUTE, [[100, 1]]], [T + 40 * MINUTE, [[100, 5]]]]);
    expect(history.covered(T, before)).toBe(true);
    history.want(T, before);
    expect(sent).toHaveLength(4);
  });

  it("a want raised while a page is being folded in neither asks the stream again nor starts over, so a page never sends its own chunk twice", () => {
    const sent: HistoryRequest[] = [];
    const stream = new ColumnHistoryStream({ request: (request) => sent.push(request), maxPerMinute: 100_000, retryMs: 1 });
    stream.setIdentity(BTC);
    const before = T + 50 * MINUTE;
    const history: LiveRangeHistory = new LiveRangeHistory(stream, () => history.want(T - STREAM_CHUNK_MS, before));
    history.want(T, before);
    expect(sent).toHaveLength(1);
    stream.accept(sent[0].requestId, page(sent[0], [column(T + 5 * MINUTE, 2)], 1, T + 30 * MINUTE));
    expect(sent).toHaveLength(2);
    expect([sent[1].fromTs, sent[1].toTs]).toEqual([T + 30 * MINUTE, before]);
    expect(history.columns(T, before)).toHaveLength(1);
    history.want(T - STREAM_CHUNK_MS, before);
    expect(sent).toHaveLength(3);
    expect(history.columns(T, before)).toHaveLength(1);
  });

  it("keeps of each host column its time, row width, trade rows and prints, and nothing of its book", () => {
    const fields = ["buy", "prints", "printsFloor", "rowWidth", "sell", "ts"];
    const kept = hostColumnOf(column(T, 2, 3), 1);
    expect(Object.keys(kept).sort()).toEqual(fields);
    expect([kept.ts, kept.rowWidth, kept.buy, kept.sell]).toEqual([T, 1, [[100, 2]], [[101, 3]]]);
    const { sent, stream, history } = harness();
    history.want(T, T + 30 * MINUTE);
    stream.accept(sent[0].requestId, page(sent[0], [column(T + MINUTE, 4), column(T + 2 * MINUTE)]));
    expect(history.columns(T, T + 30 * MINUTE).map((c) => Object.keys(c).sort())).toEqual([fields, fields]);
  });

  it("keeps the prints of each host column and the floor they were kept from, and none of a column that brought none", () => {
    const prints = [{ ts: T + MINUTE - 500, price: 100, size: 5, side: "buy" as const, id: "a" }];
    const kept = hostColumnOf({ ...column(T, 2), prints, printsFloor: 0.4 }, 1);
    expect(kept.prints).toBe(prints);
    expect(kept.printsFloor).toBe(0.4);
    const bare = hostColumnOf(column(T), 1);
    expect(bare.prints).toEqual([]);
    expect(Object.isFrozen(bare.prints)).toBe(true);
    expect(bare.printsFloor).toBeNull();
    expect(hostColumnOf({ ...column(T), printsFloor: Number.NaN }, 1).printsFloor).toBeNull();
    expect(hostColumnOf({ ...column(T), printsFloor: Number.POSITIVE_INFINITY }, 1).printsFloor).toBeNull();
    const { sent, stream, history } = harness();
    history.want(T, T + 30 * MINUTE);
    stream.accept(sent[0].requestId, page(sent[0], [{ ...column(T + MINUTE, 4), prints, printsFloor: 0.4 }, column(T + 2 * MINUTE, 1)]));
    expect(history.columns(T, T + 30 * MINUTE).map((c) => [c.prints, c.printsFloor])).toEqual([[prints, 0.4], [[], null]]);
  });

  it("forks the chart's column stream with a five-second pause after a failed page, where the lanes wait thirty", () => {
    const stream = new ColumnHistoryStream({ request: () => {}, retryMs: 30_000 });
    expect(HISTORY_RETRY_MS).toBe(5_000);
    expect(forkForLiveRange(stream).retryMs).toBe(5_000);
    expect(stream.fork().retryMs).toBe(30_000);
  });

  it("lets go of the hours that lie wholly outside the range and as much again on each side, an hour at least, so a zone dragged across the week never holds the week, and asks for a dropped hour again once the range reaches it", () => {
    const H = STREAM_CHUNK_MS;
    expect(KEEP_PAD_MIN_MS).toBe(H);
    const { sent, stream, history } = harness();
    history.want(T, T + 4 * H);
    for (const request of [...sent]) stream.accept(request.requestId, page(request, [column(request.fromTs + MINUTE, 1)]));
    expect(stamps(history, -Infinity, Infinity)).toEqual([T + MINUTE, T + H + MINUTE, T + 2 * H + MINUTE, T + 3 * H + MINUTE]);
    history.keep(T + 3 * H + 10 * MINUTE, T + 3 * H + 20 * MINUTE);
    expect(stamps(history, -Infinity, Infinity)).toEqual([T + 2 * H + MINUTE, T + 3 * H + MINUTE]);
    expect([history.covered(T, T + H), history.covered(T + H, T + 2 * H), history.covered(T + 2 * H, T + 4 * H)]).toEqual([false, false, true]);
    const asked = sent.length;
    history.want(T, T + 4 * H);
    expect(sent.slice(asked).map((r) => [r.fromTs, r.toTs])).toEqual([[T + H, T + 2 * H], [T, T + H]]);
    for (const request of sent.slice(asked)) stream.accept(request.requestId, page(request, [column(request.fromTs + MINUTE, 1)]));
    history.keep(T + 2 * H, T + 4 * H);
    expect(stamps(history, -Infinity, Infinity)).toHaveLength(4);
    history.keep(T, T + 10 * MINUTE);
    expect(stamps(history, -Infinity, Infinity)).toEqual([T + MINUTE, T + H + MINUTE]);
    history.keep(T + 7 * H + 30 * MINUTE, T + 7 * H + 40 * MINUTE);
    expect(stamps(history, -Infinity, Infinity)).toEqual([]);
    const later = harness();
    later.history.want(T, T + 2 * H);
    later.history.keep(T, T + 2 * H);
    for (const request of [...later.sent]) later.stream.accept(request.requestId, page(request, [column(request.fromTs + MINUTE, 1)]));
    expect(stamps(later.history, -Infinity, Infinity)).toEqual([T + MINUTE, T + H + MINUTE]);
  });

  it("lets nothing go while a page is being folded in, so a read the page sets off never drops the hour it brings", () => {
    const sent: HistoryRequest[] = [];
    const stream = new ColumnHistoryStream({ request: (request) => sent.push(request), maxPerMinute: 100_000, retryMs: 1 });
    stream.setIdentity(BTC);
    const history: LiveRangeHistory = new LiveRangeHistory(stream, () => history.keep(T + 10 * STREAM_CHUNK_MS, T + 10 * STREAM_CHUNK_MS + MINUTE));
    history.want(T, T + STREAM_CHUNK_MS);
    stream.accept(sent[0].requestId, page(sent[0], [column(T + MINUTE, 1)]));
    expect(stamps(history, -Infinity, Infinity)).toEqual([T + MINUTE]);
    expect(history.covered(T, T + STREAM_CHUNK_MS)).toBe(true);
  });

  it("stops listening once disposed", () => {
    const { sent, stream, changed, history } = harness();
    history.want(T, T + 30 * MINUTE);
    history.dispose();
    stream.accept(sent[0].requestId, page(sent[0], [column(T + MINUTE, 4)]));
    expect(changed).not.toHaveBeenCalled();
    expect(history.columns(T, T + 30 * MINUTE)).toEqual([]);
    history.want(T - STREAM_CHUNK_MS, T + 30 * MINUTE);
    expect(sent).toHaveLength(1);
  });
});
