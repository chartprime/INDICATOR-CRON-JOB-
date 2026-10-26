import { describe, expect, it } from "vitest";
import type { DeltaProfileFrame } from "../../../../types/frames";
import {
  DELTA_ASK_DELAY_MS,
  DELTA_GIVE_UP_MS,
  DELTA_PENDING_MS,
  DELTA_RETRY_MS,
  DeltaProfileStore,
  MAX_LIVE_SLICES,
  MAX_PIECES,
  RUNTIME_PIECE_MS,
  baseRowWidthFor,
  gapsIn,
  type ProfileWindowBounds,
} from "../deltaProfileStore";

const H = 3_600_000;
const HALF = H / 2;
const MIN = 60_000;
const OPEN = 1_790_000_040_000;
const NOW = OPEN + 5 * H;
const trade = (ts: number, price: number, size: number, side: "buy" | "sell" = "buy") => ({ ts_exchange: ts, price, size, side });
type PieceFields = Omit<DeltaProfileFrame, "type" | "symbol" | "provider" | "marketKind" | "assetClass">;
const piece = (over: Partial<PieceFields> & { request_id: number; from_ts: number; to_ts: number }): DeltaProfileFrame => ({
  type: "delta_profile", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL",
  row_width: 1, complete: true, reason: null, retry_after_ms: null, pending: 0, rows: [], ...over,
});
const day = (from: number, to: number | null = null): ProfileWindowBounds => ({ from, to, pieceMs: RUNTIME_PIECE_MS });
const fine = (from: number, to: number | null = null): ProfileWindowBounds => ({ from, to, pieceMs: HALF });

function ready(rowWidth = 1, window: ProfileWindowBounds = day(OPEN)): DeltaProfileStore {
  const store = new DeltaProfileStore(rowWidth);
  store.setWindow(window, NOW);
  return store;
}

function filled(store: DeltaProfileStore, requestId: number, from: number, to: number, at: number, price = 84_600): void {
  expect(store.put(piece({ request_id: requestId, from_ts: from, to_ts: to, rows: [[price, 1, 0]] }), at)).toBe(true);
}

describe("baseRowWidthFor", () => {
  it("is $1 on BTC, $0.10 on ETH, a cent on other crypto, a tick on futures, a cent on stocks", () => {
    expect(baseRowWidthFor({ provider: "BINANCE", marketKind: "PERPETUAL" }, "BTC-USDT")).toBe(1);
    expect(baseRowWidthFor({ provider: "BINANCE", marketKind: "SPOT" }, "ETH-USDT")).toBe(0.1);
    expect(baseRowWidthFor({ provider: "BINANCE", marketKind: "SPOT" }, "SOL-USDT")).toBe(0.01);
    expect(baseRowWidthFor({ provider: "DXFEED", assetClass: "FUTURE" }, "/NQZ26:XCME")).toBe(0.25);
    expect(baseRowWidthFor({ provider: "DXFEED", assetClass: "EQUITY" }, "AAPL")).toBe(0.01);
  });
});

describe("gapsIn", () => {
  it("is the uncovered parts of a span, newest first, whatever order the pieces come in", () => {
    expect(gapsIn([], 0, 10)).toEqual([{ from: 0, to: 10 }]);
    expect(gapsIn([{ from: 0, to: 10, volume: 0 }], 0, 10)).toEqual([]);
    expect(gapsIn([{ from: 2, to: 4, volume: 0 }, { from: 7, to: 8, volume: 0 }], 0, 10)).toEqual([{ from: 8, to: 10 }, { from: 4, to: 7 }, { from: 0, to: 2 }]);
    expect(gapsIn([{ from: 7, to: 8, volume: 0 }, { from: 2, to: 4, volume: 0 }], 3, 8)).toEqual([{ from: 4, to: 7 }]);
    expect(gapsIn([{ from: -5, to: 3, volume: 0 }, { from: 9, to: 20, volume: 0 }], 0, 10)).toEqual([{ from: 3, to: 9 }]);
    expect(gapsIn([{ from: 0, to: 4, volume: 0 }, { from: 4, to: 10, volume: 0 }], 0, 10)).toEqual([]);
    expect(gapsIn([{ from: 12, to: 15, volume: 0 }, { from: 0, to: 10, volume: 0 }], 0, 10)).toEqual([]);
    expect(gapsIn([{ from: 12, to: 15, volume: 0 }], 0, 10)).toEqual([{ from: 0, to: 10 }]);
    expect(gapsIn([], 10, 10)).toEqual([]);
    expect(gapsIn([], 10, 4)).toEqual([]);
    expect(gapsIn([{ from: 0, to: 2, volume: 0 }], 3, 8)).toEqual([{ from: 3, to: 8 }]);
  });
});

describe("DeltaProfileStore", () => {
  it("needs a positive row width and starts empty with nothing to ask until a window is set", () => {
    expect(() => new DeltaProfileStore(0)).toThrow(/rowWidth/);
    const store = new DeltaProfileStore(1);
    expect(store.nextRequest(NOW)).toBeNull();
    expect(store.addTrade(trade(NOW, 84_610, 1))).toBe(false);
    expect(store.rows()).toEqual([]);
    expect(store.complete).toBe(false);
    expect(store.windowFrom).toBeNull();
    expect(store.gaps).toEqual([]);
  });

  it("counts live trades from the cut on, by side, on the absolute row grid, and ignores what printed before the cut", () => {
    const store = ready(0.1);
    expect(store.liveFrom).toBe(NOW);
    expect(store.addTrade(trade(NOW - 1, 84_610.4, 1))).toBe(false);
    expect(store.addTrade(trade(NOW, 84_610.4, 2))).toBe(true);
    expect(store.addTrade(trade(NOW + 1, 84_610.49, 1, "sell"))).toBe(true);
    expect(store.addTrade(trade(NOW + 2, 84_610.5, 3, "sell"))).toBe(true);
    expect(store.addTrade(trade(NOW + 3, 84_610.5, 0))).toBe(false);
    expect(store.rows()).toEqual([
      { price: 84_610.4, buy: 2, sell: 1 },
      { price: 84_610.5, buy: 0, sell: 3 },
    ]);
    expect(store.version).toBe(4);
    expect(store.lastIndex).toBe(846_105);
  });

  it("remembers which rows printed lately and when, newest last, bounded", () => {
    const store = ready();
    expect(store.recent).toEqual([]);
    expect(store.lastIndex).toBeNull();
    store.addTrade(trade(NOW, 84_610, 1), 1_000);
    store.addTrade(trade(NOW + 1, 84_611, 1), 1_050);
    expect(store.recent).toEqual([{ index: 84_610, at: 1_000 }, { index: 84_611, at: 1_050 }]);
    expect(store.lastIndex).toBe(84_611);
    for (let i = 0; i < 100; i += 1) store.addTrade(trade(NOW + 2 + i, 84_600 + (i % 5), 1), 2_000 + i);
    expect(store.recent).toHaveLength(64);
    expect(store.recent.at(-1)).toEqual({ index: 84_604, at: 2_099 });
  });

  it("asks the host for the window up to the cut, only once the recorder has had time to write up to it, one request at a time, without a piece size at the runtime's own", () => {
    const store = ready();
    expect(store.nextRequest(NOW)).toBeNull();
    expect(store.nextRequest(NOW + DELTA_ASK_DELAY_MS - 1)).toBeNull();
    const request = store.nextRequest(NOW + DELTA_ASK_DELAY_MS);
    expect(request).toEqual({ request_id: 1, from_ts: OPEN, to_ts: NOW, row_width: 1 });
    expect(store.pending).toBe(true);
    expect(store.nextRequest(NOW + DELTA_ASK_DELAY_MS + 1)).toBeNull();
  });

  it("lays the pieces in newest first, adjacent to what it has, and is complete when they reach the open; a stale or non-adjacent reply is ignored", () => {
    const store = ready();
    store.addTrade(trade(NOW + 10, 84_610, 1));
    const request = store.nextRequest(NOW + DELTA_ASK_DELAY_MS)!;
    const t0 = NOW + DELTA_ASK_DELAY_MS + 100;
    expect(store.put(piece({ request_id: 99, from_ts: OPEN + 4 * H, to_ts: NOW, rows: [[84_610, 5, 0]] }), t0)).toBe(false);
    expect(store.put(piece({ request_id: request.request_id, from_ts: OPEN + 2 * H, to_ts: OPEN + 4 * H, rows: [[84_610, 5, 0]] }), t0)).toBe(false);
    expect(store.put(piece({ request_id: request.request_id, from_ts: OPEN + 4 * H, to_ts: NOW, pending: 2, rows: [[84_610, 5, 2], [84_611, 0, 1]] }), t0)).toBe(true);
    expect(store.gaps).toEqual([{ from: OPEN, to: OPEN + 4 * H }]);
    expect(store.pending).toBe(true);
    expect(store.complete).toBe(false);
    expect(store.nextRequest(t0)).toBeNull();
    expect(store.put(piece({ request_id: request.request_id, from_ts: OPEN + 2 * H, to_ts: OPEN + 4 * H, pending: 1, rows: [[84_609, 1, 0]] }), t0)).toBe(true);
    expect(store.put(piece({ request_id: request.request_id, from_ts: OPEN, to_ts: OPEN + 2 * H, pending: 0, rows: [[84_610, 0, 4]] }), t0)).toBe(true);
    expect(store.complete).toBe(true);
    expect(store.pending).toBe(false);
    expect(store.nextRequest(t0 + 60_000)).toBeNull();
    expect(store.rows()).toEqual([
      { price: 84_609, buy: 1, sell: 0 },
      { price: 84_610, buy: 6, sell: 6 },
      { price: 84_611, buy: 0, sell: 1 },
    ]);
    expect(store.pieces.sort((a, b) => a.from - b.from)).toEqual([
      { from: OPEN, to: OPEN + 2 * H, volume: 4 },
      { from: OPEN + 2 * H, to: OPEN + 4 * H, volume: 1 },
      { from: OPEN + 4 * H, to: NOW, volume: 8 },
    ]);
  });

  it("a piece at another row width is not laid in", () => {
    const store = ready();
    const request = store.nextRequest(NOW + DELTA_ASK_DELAY_MS)!;
    expect(store.put(piece({ request_id: request.request_id, from_ts: OPEN, to_ts: NOW, row_width: 10, rows: [[84_610, 5, 0]] }), NOW + DELTA_ASK_DELAY_MS)).toBe(false);
    expect(store.rows()).toEqual([]);
  });

  it("after a failed piece the remainder is asked again with backoff, a server retry hint is honoured, three failures wait ten minutes, a capped reply is final, and a success clears it", () => {
    const store = ready();
    const t0 = NOW + DELTA_ASK_DELAY_MS;
    const first = store.nextRequest(t0)!;
    store.put(piece({ request_id: first.request_id, from_ts: OPEN + 4 * H, to_ts: NOW, pending: 2, rows: [[84_610, 1, 0]] }), t0);
    expect(store.put(piece({ request_id: first.request_id, from_ts: OPEN + 2 * H, to_ts: OPEN + 4 * H, complete: false, reason: "READ_FAILED" }), t0)).toBe(true);
    expect(store.issue).toBe("READ_FAILED");
    expect(store.pending).toBe(false);
    expect(store.nextRequest(t0 + DELTA_RETRY_MS - 1)).toBeNull();
    const second = store.nextRequest(t0 + DELTA_RETRY_MS)!;
    expect(second).toMatchObject({ from_ts: OPEN, to_ts: OPEN + 4 * H });
    expect(second.request_id).not.toBe(first.request_id);
    store.put(piece({ request_id: second.request_id, from_ts: OPEN, to_ts: OPEN + 4 * H, complete: false, reason: "OVERLOADED", retry_after_ms: 7_000 }), t0 + DELTA_RETRY_MS);
    expect(store.nextRequest(t0 + DELTA_RETRY_MS + 6_999)).toBeNull();
    const third = store.nextRequest(t0 + DELTA_RETRY_MS + 7_000)!;
    store.put(piece({ request_id: third.request_id, from_ts: OPEN, to_ts: OPEN + 4 * H, complete: false, reason: "STORAGE_UNAVAILABLE" }), t0 + DELTA_RETRY_MS + 7_000);
    expect(store.nextRequest(t0 + DELTA_RETRY_MS + 7_000 + DELTA_GIVE_UP_MS - 1)).toBeNull();
    const fourth = store.nextRequest(t0 + DELTA_RETRY_MS + 7_000 + DELTA_GIVE_UP_MS)!;
    const t1 = t0 + DELTA_RETRY_MS + 7_000 + DELTA_GIVE_UP_MS;
    expect(store.put(piece({ request_id: fourth.request_id, from_ts: OPEN + 2 * H, to_ts: OPEN + 4 * H, pending: 1, rows: [[84_600, 0, 1]] }), t1)).toBe(true);
    expect(store.issue).toBeNull();
    expect(store.put(piece({ request_id: fourth.request_id, from_ts: OPEN, to_ts: OPEN + 2 * H, complete: false, reason: "READ_FAILED" }), t1)).toBe(true);
    expect(store.nextRequest(t1 + DELTA_RETRY_MS - 1)).toBeNull();
    const fifth = store.nextRequest(t1 + DELTA_RETRY_MS)!;
    expect(fifth).toMatchObject({ from_ts: OPEN, to_ts: OPEN + 2 * H });
    expect(store.put(piece({ request_id: fifth.request_id, from_ts: OPEN, to_ts: OPEN + 2 * H, rows: [[84_600, 0, 1]] }), t1 + DELTA_RETRY_MS)).toBe(true);
    expect(store.complete).toBe(true);
    expect(store.rows()).toEqual([{ price: 84_600, buy: 0, sell: 2 }, { price: 84_610, buy: 1, sell: 0 }]);

    const capped = ready(0.01);
    const ask = capped.nextRequest(NOW + DELTA_ASK_DELAY_MS)!;
    capped.put(piece({ request_id: ask.request_id, from_ts: OPEN, to_ts: NOW, row_width: 0.01, complete: false, reason: "ROWS_CAPPED" }), NOW + DELTA_ASK_DELAY_MS);
    expect(capped.issue).toBe("ROWS_CAPPED");
    expect(capped.nextRequest(NOW + DELTA_ASK_DELAY_MS + DELTA_GIVE_UP_MS * 2)).toBeNull();
    capped.setWindow(day(OPEN + 4 * H, NOW), NOW + DELTA_ASK_DELAY_MS + 1);
    expect(capped.issue).toBeNull();
    expect(capped.nextRequest(NOW + DELTA_ASK_DELAY_MS + 1)).toMatchObject({
      from_ts: OPEN + 4 * H,
      to_ts: NOW,
    });
  });

  it("a request whose pieces keep landing stays alive past DELTA_PENDING_MS: the clock restarts on every piece", () => {
    const store = ready(1, day(OPEN - 20 * H));
    const t0 = NOW + DELTA_ASK_DELAY_MS;
    const request = store.nextRequest(t0)!;
    let at = t0;
    for (let i = 0; i < 12; i += 1) {
      at += DELTA_PENDING_MS - 1_000;
      expect(store.put(piece({ request_id: request.request_id, from_ts: NOW - (i + 1) * 2 * H, to_ts: NOW - i * 2 * H, pending: 12 - i, rows: [[84_600 + i, 1, 0]] }), at)).toBe(true);
      expect(store.nextRequest(at)).toBeNull();
    }
    expect(store.pending).toBe(true);
    expect(store.put(piece({ request_id: request.request_id, from_ts: OPEN - 20 * H, to_ts: NOW - 24 * H, pending: 0, rows: [] }), at + 1_000)).toBe(true);
    expect(store.complete).toBe(true);
    expect(store.rows()).toHaveLength(12);
  });

  it("a request left unanswered expires after DELTA_PENDING_MS as a failed attempt, so the next ask goes out after the backoff", () => {
    const store = ready();
    const t0 = NOW + DELTA_ASK_DELAY_MS;
    const first = store.nextRequest(t0)!;
    expect(store.nextRequest(t0 + DELTA_PENDING_MS)).toBeNull();
    expect(store.nextRequest(t0 + DELTA_PENDING_MS + 1)).toBeNull();
    const second = store.nextRequest(t0 + DELTA_PENDING_MS + 1 + DELTA_RETRY_MS)!;
    expect(second.request_id).toBe(first.request_id + 1);
    expect(store.put(piece({ request_id: first.request_id, from_ts: OPEN, to_ts: NOW, rows: [[1, 1, 1]] }), t0 + DELTA_PENDING_MS + 1 + DELTA_RETRY_MS)).toBe(false);
  });

  it("a new day keeps the cut and what it holds: rows outside the new window are not counted, and nothing is asked when the live prints already cover it", () => {
    const store = ready();
    store.addTrade(trade(NOW + 1, 84_610, 1));
    const request = store.nextRequest(NOW + DELTA_ASK_DELAY_MS)!;
    filled(store, request.request_id, OPEN, NOW, NOW + DELTA_ASK_DELAY_MS);
    expect(store.complete).toBe(true);
    const later = NOW + H;
    store.setWindow(day(OPEN), later);
    expect(store.rows()).toHaveLength(2);
    store.setWindow(day(NOW + 30 * MIN), later);
    expect(store.rows()).toEqual([]);
    expect(store.pieces).toEqual([]);
    expect(store.liveFrom).toBe(NOW);
    expect(store.complete).toBe(true);
    expect(store.nextRequest(later + DELTA_ASK_DELAY_MS)).toBeNull();
    store.addTrade(trade(later, 84_620, 2));
    expect(store.rows()).toEqual([{ price: 84_620, buy: 2, sell: 0 }]);
    store.setWindow(day(OPEN), later + 1);
    expect(store.rows()).toEqual([{ price: 84_600, buy: 1, sell: 0 }, { price: 84_610, buy: 1, sell: 0 }, { price: 84_620, buy: 2, sell: 0 }]);
  });

  it("sets the cut just after the newest print it has been shown, on the exchange's clock, so prints that came before the window count once whatever the browser's clock says", () => {
    const store = new DeltaProfileStore(1);
    const exchange = NOW + 3_000;
    store.markSeen(exchange - 500);
    expect(store.addTrade(trade(exchange, 84_610, 1))).toBe(false);
    store.markSeen(exchange - 200);
    store.setWindow(day(OPEN), NOW);
    expect(store.liveFrom).toBe(exchange + 1);
    expect(store.addTrade(trade(exchange, 84_611, 1))).toBe(false);
    expect(store.addTrade(trade(exchange + 1, 84_612, 1))).toBe(true);
    const request = store.nextRequest(NOW + DELTA_ASK_DELAY_MS)!;
    expect(request).toMatchObject({ from_ts: OPEN, to_ts: exchange + 1 });
    expect(store.put(piece({ request_id: request.request_id, from_ts: OPEN, to_ts: exchange + 1, rows: [[84_610, 1, 0], [84_611, 1, 0]] }), NOW + DELTA_ASK_DELAY_MS)).toBe(true);
    expect(store.rows()).toEqual([
      { price: 84_610, buy: 1, sell: 0 },
      { price: 84_611, buy: 1, sell: 0 },
      { price: 84_612, buy: 1, sell: 0 },
    ]);
  });

  it("waits DELTA_ASK_DELAY_MS from the moment the cut was set, so a browser clock behind or ahead of the exchange neither holds the ask back nor rushes it", () => {
    const behind = new DeltaProfileStore(1);
    behind.markSeen(NOW + 60_000);
    behind.setWindow(day(OPEN), NOW);
    expect(behind.nextRequest(NOW + DELTA_ASK_DELAY_MS - 1)).toBeNull();
    expect(behind.nextRequest(NOW + DELTA_ASK_DELAY_MS)).toMatchObject({ from_ts: OPEN, to_ts: NOW + 60_001 });
    const ahead = new DeltaProfileStore(1);
    ahead.markSeen(NOW - 60_000);
    ahead.setWindow(day(OPEN), NOW);
    expect(ahead.nextRequest(NOW + DELTA_ASK_DELAY_MS - 1)).toBeNull();
    expect(ahead.nextRequest(NOW + DELTA_ASK_DELAY_MS)).toMatchObject({ from_ts: OPEN, to_ts: NOW - 59_999 });
  });

  it("a reconnect drops rows, pieces and the ask and forgets what it had seen; the next window sets the cut after the newest print seen since, so what the drop missed is the host's", () => {
    const store = ready();
    store.addTrade(trade(NOW + 1, 84_610, 1));
    const request = store.nextRequest(NOW + DELTA_ASK_DELAY_MS)!;
    filled(store, request.request_id, OPEN, NOW, NOW + DELTA_ASK_DELAY_MS);
    const later = NOW + H;
    store.reanchor();
    expect(store.rows()).toEqual([]);
    expect(store.pending).toBe(false);
    expect(store.liveFrom).toBeNull();
    expect(store.nextRequest(later + DELTA_ASK_DELAY_MS)).toBeNull();
    store.markSeen(later - 5);
    expect(store.addTrade(trade(later - 1, 84_610, 1))).toBe(false);
    store.setWindow(day(OPEN), later - H);
    expect(store.liveFrom).toBe(later);
    expect(store.addTrade(trade(later - 1, 84_610, 1))).toBe(false);
    expect(store.addTrade(trade(later, 84_611, 1))).toBe(true);
    expect(store.nextRequest(later - H + DELTA_ASK_DELAY_MS)).toMatchObject({ from_ts: OPEN, to_ts: later });

    const quiet = ready();
    quiet.addTrade(trade(NOW + 1, 84_610, 1));
    quiet.reanchor();
    quiet.setWindow(day(OPEN), later);
    expect(quiet.liveFrom).toBe(later);
  });

  it("a window that opened at the cut has nothing to ask", () => {
    const store = new DeltaProfileStore(1);
    store.setWindow(day(NOW), NOW);
    expect(store.nextRequest(NOW + DELTA_ASK_DELAY_MS)).toBeNull();
    expect(store.complete).toBe(true);
  });

  it("a closed window (a session) is asked only up to its close, leaves out live prints after it, and a frozen one is complete once the pieces are in", () => {
    const store = ready(1, day(OPEN, OPEN + 2 * H));
    store.addTrade(trade(NOW, 84_610, 1));
    expect(store.rows()).toEqual([]);
    expect(store.nextRequest(NOW + DELTA_ASK_DELAY_MS)).toEqual({ request_id: 1, from_ts: OPEN, to_ts: OPEN + 2 * H, row_width: 1 });
    expect(store.put(piece({ request_id: 1, from_ts: OPEN, to_ts: OPEN + 2 * H, rows: [[84_600, 3, 1]] }), NOW + DELTA_ASK_DELAY_MS)).toBe(true);
    expect(store.complete).toBe(true);
    expect(store.rows()).toEqual([{ price: 84_600, buy: 3, sell: 1 }]);
    const open = ready(1, day(NOW - H, NOW + H));
    open.addTrade(trade(NOW + H, 84_610, 1));
    open.addTrade(trade(NOW + H - 1, 84_611, 1));
    expect(open.rows()).toEqual([{ price: 84_611, buy: 1, sell: 0 }]);
    expect(open.nextRequest(NOW + DELTA_ASK_DELAY_MS)).toMatchObject({ from_ts: NOW - H, to_ts: NOW });
  });

  it("a sliding window asks in its own piece size, keeps what is still inside when it moves on, and counts only what is inside", () => {
    const store = ready(1, fine(NOW - 4 * H));
    store.addTrade(trade(NOW + MIN, 84_620, 1));
    store.addTrade(trade(NOW + HALF + MIN, 84_621, 1));
    const request = store.nextRequest(NOW + DELTA_ASK_DELAY_MS)!;
    expect(request).toEqual({ request_id: 1, from_ts: NOW - 4 * H, to_ts: NOW, row_width: 1, piece_ms: HALF });
    const t0 = NOW + DELTA_ASK_DELAY_MS;
    store.put(piece({ request_id: 1, from_ts: NOW - HALF, to_ts: NOW, pending: 7, rows: [[84_610, 1, 0]] }), t0);
    for (let i = 1; i < 8; i += 1) {
      store.put(piece({ request_id: 1, from_ts: NOW - (i + 1) * HALF, to_ts: NOW - i * HALF, pending: 7 - i, rows: [[84_600 + i, 1, 0]] }), t0);
    }
    expect(store.complete).toBe(true);
    expect(store.rows()).toHaveLength(10);

    store.setWindow(fine(NOW - 4 * H + HALF), NOW + HALF);
    expect(store.rows().map((row) => row.price)).toEqual([84_601, 84_602, 84_603, 84_604, 84_605, 84_606, 84_610, 84_620, 84_621]);
    expect(store.complete).toBe(true);
    expect(store.nextRequest(NOW + HALF)).toBeNull();
    store.setWindow(fine(NOW - 4 * H + 5 * HALF), NOW + 5 * HALF);
    expect(store.rows().map((row) => row.price)).toEqual([84_601, 84_602, 84_610, 84_620, 84_621]);
    store.setWindow(fine(NOW + HALF), NOW + 9 * HALF);
    expect(store.rows().map((row) => row.price)).toEqual([84_621]);
    expect(store.complete).toBe(true);
    store.setWindow(fine(NOW - 4 * H), NOW + 9 * HALF);
    expect(store.rows()).toHaveLength(10);
    expect(store.complete).toBe(true);
  });

  it("the same window again changes nothing: the request out stays out", () => {
    const store = ready(1, fine(NOW - 4 * H));
    store.nextRequest(NOW + DELTA_ASK_DELAY_MS);
    const version = store.version;
    store.setWindow(fine(NOW - 4 * H), NOW + DELTA_ASK_DELAY_MS + 1);
    expect(store.pending).toBe(true);
    expect(store.version).toBe(version);
  });

  it("a window that moves while a request is out drops that request and asks for what is still missing", () => {
    const store = ready(1, fine(NOW - 4 * H));
    const first = store.nextRequest(NOW + DELTA_ASK_DELAY_MS)!;
    store.put(piece({ request_id: first.request_id, from_ts: NOW - HALF, to_ts: NOW, pending: 7, rows: [[84_610, 1, 0]] }), NOW + DELTA_ASK_DELAY_MS);
    store.setWindow(fine(NOW - 4 * H + HALF), NOW + HALF);
    expect(store.pending).toBe(false);
    expect(store.put(piece({ request_id: first.request_id, from_ts: NOW - 2 * HALF, to_ts: NOW - HALF, pending: 6, rows: [[84_609, 1, 0]] }), NOW + HALF)).toBe(false);
    const second = store.nextRequest(NOW + HALF)!;
    expect(second).toMatchObject({ from_ts: NOW - 4 * H + HALF, to_ts: NOW - HALF, piece_ms: HALF });
    expect(store.put(piece({ request_id: second.request_id, from_ts: NOW - 4 * H + HALF, to_ts: NOW - HALF, rows: [[84_600, 1, 0]] }), NOW + HALF)).toBe(true);
    expect(store.complete).toBe(true);
    expect(store.rows().map((row) => row.price)).toEqual([84_600, 84_610]);
  });

  it("a pan (a window back in time) asks only for the gaps, newest first, reuses the pieces it holds, drops a piece the new edge cuts, and a window past the cut gets no live prints", () => {
    const store = ready(1, fine(NOW - 2 * H, NOW - H));
    store.addTrade(trade(NOW + 1, 84_690, 1));
    const first = store.nextRequest(NOW + DELTA_ASK_DELAY_MS)!;
    expect(first).toMatchObject({ from_ts: NOW - 2 * H, to_ts: NOW - H, piece_ms: HALF });
    const t0 = NOW + DELTA_ASK_DELAY_MS;
    store.put(piece({ request_id: 1, from_ts: NOW - 3 * HALF, to_ts: NOW - H, pending: 1, rows: [[84_601, 1, 0]] }), t0);
    filled(store, 1, NOW - 2 * H, NOW - 3 * HALF, t0, 84_600);
    expect(store.complete).toBe(true);
    expect(store.rows().map((row) => row.price)).toEqual([84_600, 84_601]);

    store.setWindow(fine(NOW - 3 * H, NOW - HALF), t0);
    expect(store.gaps).toEqual([{ from: NOW - H, to: NOW - HALF }, { from: NOW - 3 * H, to: NOW - 2 * H }]);
    const second = store.nextRequest(t0)!;
    expect(second).toMatchObject({ from_ts: NOW - H, to_ts: NOW - HALF });
    filled(store, 2, NOW - H, NOW - HALF, t0, 84_602);
    const third = store.nextRequest(t0)!;
    expect(third).toMatchObject({ from_ts: NOW - 3 * H, to_ts: NOW - 2 * H });
    store.put(piece({ request_id: 3, from_ts: NOW - 5 * HALF, to_ts: NOW - 2 * H, pending: 1, rows: [[84_603, 1, 0]] }), t0);
    filled(store, 3, NOW - 3 * H, NOW - 5 * HALF, t0, 84_604);
    expect(store.complete).toBe(true);
    expect(store.rows().map((row) => row.price)).toEqual([84_600, 84_601, 84_602, 84_603, 84_604]);

    store.setWindow(fine(NOW - 2 * H - 10 * MIN, NOW - H - 10 * MIN), t0);
    expect(store.gaps).toEqual([{ from: NOW - 3 * HALF, to: NOW - H - 10 * MIN }, { from: NOW - 2 * H - 10 * MIN, to: NOW - 2 * H }]);
    expect(store.rows().map((row) => row.price)).toEqual([84_600]);
    store.setWindow(fine(NOW - 2 * H + 10 * MIN, NOW - H), t0);
    expect(store.gaps).toEqual([{ from: NOW - 2 * H + 10 * MIN, to: NOW - H }]);
    expect(store.rows()).toEqual([]);
    const again = store.nextRequest(t0)!;
    store.put(piece({ request_id: again.request_id, from_ts: NOW - 3 * HALF, to_ts: NOW - H, pending: 1, rows: [[84_601, 1, 0]] }), t0);
    filled(store, again.request_id, NOW - 2 * H + 10 * MIN, NOW - 3 * HALF, t0, 84_605);
    expect(store.complete).toBe(true);
    expect(store.rows().map((row) => row.price)).toEqual([84_601, 84_605]);

    store.setWindow(fine(NOW - 2 * H), t0);
    expect(store.gaps).toEqual([{ from: NOW - HALF, to: NOW }, { from: NOW - 2 * H, to: NOW - 2 * H + 10 * MIN }]);
    expect(store.rows().map((row) => row.price)).toEqual([84_601, 84_602, 84_605, 84_690]);
  });

  it("keeps a bounded number of pieces: pieces outside the window go first, then the oldest inside", () => {
    const store = ready(1, fine(NOW - 24 * H));
    const request = store.nextRequest(NOW + DELTA_ASK_DELAY_MS)!;
    for (let i = 0; i < MAX_PIECES + 4; i += 1) {
      const from = NOW - (i + 1) * MIN;
      expect(store.put(piece({ request_id: request.request_id, from_ts: from, to_ts: from + MIN, pending: 1, rows: [[84_600, 1, 0]] }), NOW + DELTA_ASK_DELAY_MS)).toBe(true);
    }
    expect(store.gaps).toEqual([{ from: NOW - 24 * H, to: NOW - MAX_PIECES * MIN }]);
    expect(store.rows()).toEqual([{ price: 84_600, buy: MAX_PIECES, sell: 0 }]);

    const outside = ready(1, fine(NOW - 2 * H, NOW - H));
    const ask = outside.nextRequest(NOW + DELTA_ASK_DELAY_MS)!;
    filled(outside, ask.request_id, NOW - 2 * H, NOW - H, NOW + DELTA_ASK_DELAY_MS, 84_700);
    outside.setWindow(fine(NOW - 24 * H, NOW - 2 * H), NOW + DELTA_ASK_DELAY_MS);
    const older = outside.nextRequest(NOW + DELTA_ASK_DELAY_MS)!;
    for (let i = 0; i < MAX_PIECES; i += 1) {
      const from = NOW - 2 * H - (i + 1) * MIN;
      expect(outside.put(piece({ request_id: older.request_id, from_ts: from, to_ts: from + MIN, pending: 1, rows: [[84_600, 1, 0]] }), NOW + DELTA_ASK_DELAY_MS)).toBe(true);
    }
    outside.setWindow(fine(NOW - 3 * H, NOW - H), NOW + DELTA_ASK_DELAY_MS);
    expect(outside.gaps).toEqual([{ from: NOW - 2 * H, to: NOW - H }]);
    expect(outside.rows()).toEqual([{ price: 84_600, buy: 60, sell: 0 }]);

    const before = ready(1, fine(NOW - 2 * H, NOW - H));
    const early = before.nextRequest(NOW + DELTA_ASK_DELAY_MS)!;
    filled(before, early.request_id, NOW - 2 * H, NOW - H, NOW + DELTA_ASK_DELAY_MS, 84_700);
    before.setWindow(fine(NOW - H), NOW + DELTA_ASK_DELAY_MS);
    const newer = before.nextRequest(NOW + DELTA_ASK_DELAY_MS)!;
    for (let i = 0; i < MAX_PIECES; i += 1) {
      const from = NOW - (i + 1) * 1_000;
      expect(before.put(piece({ request_id: newer.request_id, from_ts: from, to_ts: from + 1_000, pending: 1, rows: [[84_600, 1, 0]] }), NOW + DELTA_ASK_DELAY_MS)).toBe(true);
    }
    before.setWindow(fine(NOW - 2 * H), NOW + DELTA_ASK_DELAY_MS);
    expect(before.gaps).toEqual([{ from: NOW - 2 * H, to: NOW - MAX_PIECES * 1_000 }]);

    const far = ready(1, fine(NOW - 4 * H, NOW - 3 * H));
    const farAsk = far.nextRequest(NOW + DELTA_ASK_DELAY_MS)!;
    filled(far, farAsk.request_id, NOW - 4 * H, NOW - 3 * H, NOW + DELTA_ASK_DELAY_MS, 84_700);
    far.setWindow(fine(NOW - HALF, NOW - 25 * MIN), NOW + DELTA_ASK_DELAY_MS);
    const nearAsk = far.nextRequest(NOW + DELTA_ASK_DELAY_MS)!;
    filled(far, nearAsk.request_id, NOW - HALF, NOW - 25 * MIN, NOW + DELTA_ASK_DELAY_MS, 84_701);
    far.setWindow(fine(NOW - H, NOW - HALF), NOW + DELTA_ASK_DELAY_MS);
    const between = far.nextRequest(NOW + DELTA_ASK_DELAY_MS)!;
    for (let i = 0; i < MAX_PIECES - 1; i += 1) {
      const from = NOW - HALF - (i + 1) * 1_000;
      expect(far.put(piece({ request_id: between.request_id, from_ts: from, to_ts: from + 1_000, pending: 1, rows: [[84_600, 1, 0]] }), NOW + DELTA_ASK_DELAY_MS)).toBe(true);
    }
    far.setWindow(fine(NOW - 4 * H, NOW - 25 * MIN), NOW + DELTA_ASK_DELAY_MS);
    expect(far.gaps).toEqual([{ from: NOW - 4 * H, to: NOW - HALF - (MAX_PIECES - 1) * 1_000 }]);
    expect(far.rows().map((row) => row.price)).toEqual([84_600, 84_701]);
  });

  it("past MAX_LIVE_SLICES hands its oldest live minutes to the host up to the next two-hour mark, so a page open for days keeps every print once the host answers", () => {
    const store = new DeltaProfileStore(1);
    store.setWindow(day(OPEN), OPEN + MIN);
    const printed: number[] = [];
    for (let i = 0; i < 3 * 1_440; i += 1) {
      printed.push(OPEN + MIN + i * MIN);
      store.addTrade(trade(OPEN + MIN + i * MIN, 84_600, 1));
    }
    const cut = store.liveFrom!;
    expect(cut % RUNTIME_PIECE_MS).toBe(0);
    expect(cut).toBeGreaterThan(OPEN + MIN);
    expect(printed.filter((ts) => ts >= cut).length).toBeLessThanOrEqual(MAX_LIVE_SLICES);
    expect(store.gaps).toEqual([{ from: OPEN, to: cut }]);
    expect(store.rows()).toEqual([{ price: 84_600, buy: printed.filter((ts) => ts >= cut).length, sell: 0 }]);
    const end = OPEN + 4 * 1_440 * MIN;
    for (let request = store.nextRequest(end); request !== null; request = store.nextRequest(end)) {
      const { request_id, from_ts, to_ts } = request;
      const bought = printed.filter((ts) => ts >= from_ts && ts < to_ts).length;
      expect(store.put(piece({ request_id, from_ts, to_ts, rows: [[84_600, bought, 0]] }), end)).toBe(true);
    }
    expect(store.complete).toBe(true);
    expect(store.rows()).toEqual([{ price: 84_600, buy: 3 * 1_440, sell: 0 }]);
  });
});
