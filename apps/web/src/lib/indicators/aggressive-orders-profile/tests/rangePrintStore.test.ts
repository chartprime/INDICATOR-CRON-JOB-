import { describe, expect, it, vi } from "vitest";
import { nextAggressiveHistoryRequestId } from "../../aggressive-orders/aggressiveTape";
import {
  MAX_LIVE_PRINTS,
  MAX_PAGES_PER_ASK,
  MAX_RECORDED_PRINTS,
  RANGE_ASK_BUDGET,
  RANGE_ASK_BUDGET_MS,
  RANGE_ASK_DELAY_MS,
  RANGE_ASK_MAX_MS,
  RANGE_GIVE_UP_MS,
  RANGE_PENDING_MS,
  RANGE_POLL_MS,
  RANGE_RETRY_MAX_ATTEMPTS,
  RANGE_RETRY_MS,
  RangePrintStore,
  gapsOf,
  nextAsk,
  type RangePrint,
  type CandleSlot,
  type RangePrintReply,
  type RangePrintRequest,
} from "../rangePrintStore";

const T = 1_700_000_000_000;
const H = 3_600_000;
const ready = T + RANGE_ASK_DELAY_MS;

function print(ts: number, side: "buy" | "sell", size: number, price = 1_000): RangePrint {
  return { ts_exchange: ts, price, side, size };
}

function tally(buyCount: number, buyVolume: number, sellCount: number, sellVolume: number) {
  return { buyCount, buyVolume, sellCount, sellVolume };
}

function reply(request: RangePrintRequest, overrides: Partial<RangePrintReply> = {}): RangePrintReply {
  return { request_id: request.request_id, from_ts: request.from_ts, to_ts: request.to_ts, min_size: request.min_size, reason: null, next_cursor: null, retry_after_ms: null, ...overrides };
}

function anchored(from = T - H, to = T, floor = 10): RangePrintStore {
  const store = new RangePrintStore();
  store.markSeen(T - 1);
  store.setWant({ from, to, floor }, T);
  return store;
}

describe("gapsOf", () => {
  it("is what the spans leave of [from, to), oldest first, whatever order the spans come in", () => {
    expect(gapsOf([{ from: 30, to: 40 }, { from: 10, to: 20 }], 0, 50)).toEqual([{ from: 0, to: 10 }, { from: 20, to: 30 }, { from: 40, to: 50 }]);
    expect(gapsOf([{ from: 0, to: 60 }], 10, 50)).toEqual([]);
    expect(gapsOf([], 10, 50)).toEqual([{ from: 10, to: 50 }]);
    expect(gapsOf([{ from: 5, to: 15 }, { from: 12, to: 30 }, { from: 60, to: 70 }], 10, 50)).toEqual([{ from: 30, to: 50 }]);
    expect(gapsOf([{ from: 50, to: 60 }], 10, 50)).toEqual([{ from: 10, to: 50 }]);
  });
});

describe("RangePrintStore", () => {
  it("sets its cut just after the newest print seen when first wanted, or at the clock with none seen, and keeps only live prints at or above the floor from the cut", () => {
    const store = new RangePrintStore();
    store.markSeen(T - 5);
    store.markSeen(T - 9);
    store.setWant({ from: T - H, to: T + H, floor: 10 }, T + 123);
    expect(store.liveFrom).toBe(T - 4);
    expect(store.addTrade(print(T - 5, "buy", 50))).toBe(false);
    expect(store.addTrade(print(T, "buy", 9.99))).toBe(false);
    expect(store.addTrade(print(T, "buy", 10))).toBe(true);
    expect(store.addTrade(print(T + 1, "sell", 30))).toBe(true);
    expect(store.addTrade(print(T + 2, "sell", 70))).toBe(true);
    expect(store.liveCount).toBe(3);
    expect(store.read(T - 4, T + 2, 10, T)).toEqual({ buyCount: 1, buyVolume: 10, sellCount: 1, sellVolume: 30, gaps: [], loading: false });
    expect(store.read(T, T, 10, T)).toBeNull();
    const fresh = new RangePrintStore();
    expect(fresh.addTrade(print(T, "buy", 50))).toBe(false);
    const clean = new RangePrintStore();
    clean.setWant({ from: T - H, to: T, floor: 10 }, T + 7);
    expect(clean.liveFrom).toBe(T + 7);
  });

  it("ignores a want with no floor or no length, rounds the window to whole milliseconds, and keeps the floor of its first want for good, a higher or a lower one changing nothing", () => {
    const store = anchored();
    const version = store.version;
    store.setWant({ from: T, to: T, floor: 20 }, T);
    store.setWant({ from: T - H, to: T, floor: 0 }, T);
    store.setWant({ from: T - H, to: T, floor: Infinity }, T);
    expect(store.version).toBe(version);
    expect(store.floor).toBe(10);
    expect(store.gaps()).toEqual([{ from: T - H, to: T }]);
    const unfloored = new RangePrintStore();
    unfloored.setWant({ from: T - H, to: T, floor: Infinity }, T);
    unfloored.setWant({ from: T - H, to: T, floor: Number.NaN }, T);
    expect([unfloored.floor, unfloored.version, unfloored.gaps()]).toEqual([null, 0, []]);
    store.addTrade(print(T + 5, "buy", 20));
    store.setWant({ from: T - H + 0.4, to: T - 0.4, floor: 10 }, T + 10);
    expect(store.read(T, T + 10, 10, T)!.buyCount).toBe(1);
    store.addTrade(print(T + 6, "sell", 12));
    store.setWant({ from: T - H, to: T, floor: 5 }, T + 20);
    store.setWant({ from: T - H, to: T, floor: 20 }, T + 30);
    expect(store.floor).toBe(10);
    expect(store.version).toBe(version);
    expect([store.liveFrom, store.liveCount]).toEqual([T, 2]);
    expect(store.addTrade(print(T + 7, "buy", 9))).toBe(false);
    expect(store.nextRequest(ready)).toMatchObject({ from_ts: T - H, to_ts: T, min_size: 10 });
    expect(store.read(T, T + 10, 20, T)).toEqual({ ...tally(1, 20, 0, 0), gaps: [], loading: false });
    expect(store.read(T, T + 10, 10, T)).toEqual({ ...tally(1, 20, 1, 12), gaps: [], loading: false });
    expect(store.read(T, T + 10, 5, T)).toEqual({ ...tally(0, 0, 0, 0), gaps: [{ from: T, to: T + 10 }], loading: true });
  });

  it("asks the recording once the recorder has had RANGE_ASK_DELAY_MS past the cut, for the newest part of the window before the cut, RANGE_ASK_MAX_MS at most, one request at a time, with ids from the counter Aggressive Orders uses", () => {
    expect([RANGE_ASK_DELAY_MS, RANGE_ASK_MAX_MS, RANGE_POLL_MS]).toEqual([5_000, 6 * H, 1_000]);
    const store = anchored(T - 8 * H, T + H);
    expect(store.nextRequest(ready - 1)).toBeNull();
    const before = nextAggressiveHistoryRequestId();
    const first = store.nextRequest(ready)!;
    expect(first).toEqual({ request_id: before + 1, from_ts: T - RANGE_ASK_MAX_MS, to_ts: T, min_size: 10 });
    expect(store.pending).toBe(true);
    expect(store.owns(first.request_id)).toBe(true);
    expect(store.nextRequest(ready + 1)).toBeNull();
    expect(store.put(reply(first), [print(T - 1_000, "sell", 12), print(T - 500, "buy", 15)], ready + 2)).toBe(true);
    expect(store.pending).toBe(false);
    expect(store.owns(first.request_id)).toBe(false);
    const second = store.nextRequest(ready + 3)!;
    expect(second.request_id).toBeGreaterThan(first.request_id);
    expect([second.from_ts, second.to_ts]).toEqual([T - 8 * H, T - RANGE_ASK_MAX_MS]);
    store.put(reply(second), [print(T - 7 * H, "buy", 40)], ready + 4);
    expect(store.nextRequest(ready + 5)).toBeNull();
    expect(store.gaps()).toEqual([]);
    expect(store.recordedCount).toBe(3);
    expect(store.read(T - 8 * H, T + H, 10, ready)).toEqual({ buyCount: 2, buyVolume: 55, sellCount: 1, sellVolume: 12, gaps: [], loading: false });
  });

  it("asks the newest gap first when what it recorded leaves two", () => {
    const store = anchored(T - 3 * H, T);
    store.setWant({ from: T - 2 * H, to: T - H, floor: 10 }, T);
    const middle = store.nextRequest(ready)!;
    store.put(reply(middle), [], ready);
    store.setWant({ from: T - 3 * H, to: T, floor: 10 }, ready);
    expect(store.gaps()).toEqual([{ from: T - 3 * H, to: T - 2 * H }, { from: T - H, to: T }]);
    expect(store.nextRequest(ready)).toMatchObject({ from_ts: T - H, to_ts: T });
  });

  it("with a focus asks what the focus leaves open first, newest first and RANGE_ASK_MAX_MS at most, then the stretch after it from its near end, then the stretch before it from its near end", () => {
    const store = anchored(T - 8 * H, T);
    store.setWant({ from: T - 8 * H, to: T, floor: 10, focus: { from: T - 5 * H + 0.4, to: T - 3 * H - 0.4 } }, T);
    const inside = store.nextRequest(ready)!;
    expect([inside.from_ts, inside.to_ts]).toEqual([T - 5 * H, T - 3 * H]);
    store.put(reply(inside), [], ready);
    const after = store.nextRequest(ready)!;
    expect([after.from_ts, after.to_ts]).toEqual([T - 3 * H, T]);
    store.put(reply(after), [], ready);
    const before = store.nextRequest(ready)!;
    expect([before.from_ts, before.to_ts]).toEqual([T - 8 * H, T - 5 * H]);
    store.put(reply(before), [], ready);
    expect(store.nextRequest(ready)).toBeNull();
    const wide = anchored(T - 20 * H, T);
    wide.setWant({ from: T - 20 * H, to: T, floor: 10, focus: { from: T - 18 * H, to: T - 2 * H } }, T);
    expect(wide.nextRequest(ready)).toMatchObject({ from_ts: T - 8 * H, to_ts: T - 2 * H });
    expect(nextAsk([{ from: T - 20 * H, to: T - 11 * H }, { from: T - 10 * H, to: T }], { from: T - 18 * H, to: T - 2 * H })).toEqual({ from: T - 8 * H, to: T - 2 * H });
    expect(nextAsk([{ from: T - 20 * H, to: T - 11 * H }], { from: T - 18 * H, to: T - 2 * H })).toEqual({ from: T - 17 * H, to: T - 11 * H });
    expect(nextAsk([{ from: T - 20 * H, to: T - 18 * H }, { from: T - 2 * H, to: T }], { from: T - 18 * H, to: T - 2 * H })).toEqual({ from: T - 2 * H, to: T });
    expect(nextAsk([{ from: T - 20 * H, to: T - 18 * H }, { from: T - H, to: T }], { from: T - 18 * H, to: T - 2 * H })).toEqual({ from: T - H, to: T });
    expect(nextAsk([{ from: T - 2 * H, to: T + 10 * H }], { from: T - 18 * H, to: T - 2 * H })).toEqual({ from: T - 2 * H, to: T + 4 * H });
    expect(nextAsk([{ from: T - 30 * H, to: T - 18 * H }], { from: T - 18 * H, to: T - 2 * H })).toEqual({ from: T - 24 * H, to: T - 18 * H });
    expect(nextAsk([{ from: T - 30 * H, to: T - 21 * H }, { from: T - 20 * H, to: T - 19 * H }], { from: T - 18 * H, to: T - 2 * H })).toEqual({ from: T - 20 * H, to: T - 19 * H });
    expect(nextAsk([{ from: T - 30 * H, to: T - 20 * H }], { from: T - 18 * H, to: T - 2 * H })).toEqual({ from: T - 26 * H, to: T - 20 * H });
    expect(nextAsk([{ from: T - 3 * H, to: T }], { from: T - 2 * H, to: T - H })).toEqual({ from: T - 2 * H, to: T - H });
    expect(nextAsk([{ from: T - 9 * H, to: T }], null)).toEqual({ from: T - 6 * H, to: T });
    expect(nextAsk([], { from: T - 2 * H, to: T - H })).toBeNull();
    expect(nextAsk([], null)).toBeNull();
    const off = anchored(T - 8 * H, T);
    off.setWant({ from: T - 8 * H, to: T, floor: 10, focus: { from: T + H, to: T + 2 * H } }, T);
    expect(off.nextRequest(ready)).toMatchObject({ from_ts: T - 6 * H, to_ts: T });
    const flat = anchored(T - 8 * H, T);
    flat.setWant({ from: T - 8 * H, to: T, floor: 10, focus: { from: T - 4 * H, to: T - 4 * H } }, T);
    expect(flat.nextRequest(ready)).toMatchObject({ from_ts: T - 6 * H, to_ts: T });
  });

  it("counts a recorded piece print by print where the range cuts it, and drops prints the reply should not have held", () => {
    const store = anchored();
    const request = store.nextRequest(ready)!;
    store.put(reply(request), [print(T - H, "buy", 10), print(T - 30 * 60_000, "sell", 11), print(T - 10 * 60_000, "buy", 9), print(T - 1, "buy", 13), print(T, "sell", 99), print(T - H - 1, "sell", 99)], ready);
    expect(store.recordedCount).toBe(3);
    expect(store.read(T - 40 * 60_000, T - 20 * 60_000, 10, ready)).toEqual({ buyCount: 0, buyVolume: 0, sellCount: 1, sellVolume: 11, gaps: [], loading: false });
    expect(store.read(T - 40 * 60_000, T, 10, ready)).toMatchObject({ buyCount: 1, buyVolume: 13, sellCount: 1 });
    expect(store.read(T - H, T - 30 * 60_000, 10, ready)).toMatchObject({ buyCount: 1, sellCount: 0 });
    expect(store.read(T - 2 * H, T - 90 * 60_000, 10, ready)).toMatchObject({ gaps: [{ from: T - 2 * H, to: T - 90 * 60_000 }], loading: true });
  });

  it("follows the cursor of a capped reply over the same window and lays the pages in as one piece when the last one lands", () => {
    const store = anchored();
    const first = store.nextRequest(ready)!;
    expect(store.put(reply(first, { reason: "CAP_REACHED", next_cursor: "abc" }), [print(T - 100, "buy", 20)], ready)).toBe(true);
    expect(store.recordedCount).toBe(0);
    expect(store.read(T - H, T, 10, ready)).toMatchObject({ buyCount: 0, loading: true });
    const page = store.nextRequest(ready + 1)!;
    expect(page).toEqual({ request_id: page.request_id, from_ts: T - H, to_ts: T, min_size: 10, cursor: "abc" });
    expect(page.request_id).not.toBe(first.request_id);
    expect(store.put(reply(page), [print(T - 2 * 60_000, "sell", 30)], ready + 2)).toBe(true);
    expect(store.read(T - H, T, 10, ready)).toEqual({ buyCount: 1, buyVolume: 20, sellCount: 1, sellVolume: 30, gaps: [], loading: false });
  });

  it("gives up a window too dense for MAX_PAGES_PER_ASK pages, and one the recording could not convert, until RANGE_GIVE_UP_MS has passed", () => {
    expect([MAX_PAGES_PER_ASK, RANGE_GIVE_UP_MS]).toEqual([20, 600_000]);
    const store = anchored();
    for (let page = 1; page < MAX_PAGES_PER_ASK; page += 1) {
      const request = store.nextRequest(ready + page)!;
      store.put(reply(request, { reason: "CAP_REACHED", next_cursor: `c${page}` }), [], ready + page);
    }
    const last = store.nextRequest(ready + MAX_PAGES_PER_ASK)!;
    expect(last.cursor).toBe(`c${MAX_PAGES_PER_ASK - 1}`);
    store.put(reply(last, { reason: "CAP_REACHED", next_cursor: "more" }), [], ready + MAX_PAGES_PER_ASK);
    expect(store.issue).toBe("CAP_REACHED");
    expect(store.nextRequest(ready + MAX_PAGES_PER_ASK + 1)).toBeNull();
    expect(store.read(T - H, T, 10, ready + MAX_PAGES_PER_ASK + 1)).toMatchObject({ gaps: [{ from: T - H, to: T }], loading: false });
    expect(store.nextRequest(ready + MAX_PAGES_PER_ASK + RANGE_GIVE_UP_MS)).toMatchObject({ from_ts: T - H, to_ts: T });
    const broken = anchored();
    const request = broken.nextRequest(ready)!;
    broken.put(reply(request, { reason: "CONVERSION_INCOMPLETE" }), [print(T - 5, "buy", 20)], ready);
    expect(broken.issue).toBe("CONVERSION_INCOMPLETE");
    expect(broken.recordedCount).toBe(0);
    expect(broken.read(T - H, T, 10, ready)).toMatchObject({ loading: false });
    const uncursored = anchored();
    const capped = uncursored.nextRequest(ready)!;
    uncursored.put(reply(capped, { reason: "CAP_REACHED", next_cursor: null }), [print(T - 5, "buy", 20)], ready);
    expect(uncursored.issue).toBe("CONVERSION_INCOMPLETE");
    expect(uncursored.nextRequest(ready + 1)).toBeNull();
  });

  it("waits as long as the host says when it is busy, backs off on a failed read, and gives the stretch up after RANGE_RETRY_MAX_ATTEMPTS failures", () => {
    expect([RANGE_RETRY_MAX_ATTEMPTS, RANGE_RETRY_MS]).toEqual([3, 10_000]);
    const store = anchored();
    let request = store.nextRequest(ready)!;
    store.put(reply(request, { reason: "OVERLOADED", retry_after_ms: 4_000 }), [], ready);
    expect(store.nextRequest(ready + 3_999)).toBeNull();
    request = store.nextRequest(ready + 4_000)!;
    expect([request.from_ts, request.to_ts]).toEqual([T - H, T]);
    store.put(reply(request, { reason: "READ_FAILED" }), [], ready + 4_000);
    expect(store.nextRequest(ready + 4_000 + RANGE_RETRY_MS - 1)).toBeNull();
    request = store.nextRequest(ready + 4_000 + RANGE_RETRY_MS)!;
    store.put(reply(request, { reason: "STORAGE_UNAVAILABLE" }), [], ready + 20_000);
    expect(store.nextRequest(ready + 20_000 + 2 * RANGE_RETRY_MS - 1)).toBeNull();
    expect(store.issue).toBeNull();
    request = store.nextRequest(ready + 20_000 + 2 * RANGE_RETRY_MS)!;
    store.put(reply(request, { reason: "OVERLOADED" }), [], ready + 60_000);
    expect(store.issue).toBe("OVERLOADED");
    expect(store.nextRequest(ready + 60_001)).toBeNull();
    expect(store.read(T - H, T, 10, ready + 60_001)).toMatchObject({ gaps: [{ from: T - H, to: T }], loading: false });
    expect(store.read(T - H, T, 10, ready + 60_000 + RANGE_GIVE_UP_MS)).toMatchObject({ loading: true });
    expect(store.nextRequest(ready + 60_000 + RANGE_GIVE_UP_MS)).toMatchObject({ from_ts: T - H, to_ts: T });
  });

  it("counts a request nobody answered for RANGE_PENDING_MS as failed and asks the same page again after the back-off", () => {
    expect(RANGE_PENDING_MS).toBe(30_000);
    const store = anchored();
    const first = store.nextRequest(ready)!;
    expect(store.nextRequest(ready + RANGE_PENDING_MS)).toBeNull();
    expect(store.pending).toBe(true);
    expect(store.nextRequest(ready + RANGE_PENDING_MS + 1)).toBeNull();
    expect(store.pending).toBe(false);
    expect(store.nextRequest(ready + RANGE_PENDING_MS + RANGE_RETRY_MS)).toBeNull();
    const again = store.nextRequest(ready + RANGE_PENDING_MS + 1 + RANGE_RETRY_MS)!;
    expect(again).toMatchObject({ from_ts: first.from_ts, to_ts: first.to_ts });
    expect(store.put(reply(first), [], ready)).toBe(false);
  });

  it("asks the same page again with a new id, at no cost, when another request on the channel made the host drop its own", () => {
    const store = anchored();
    const first = store.nextRequest(ready)!;
    store.put(reply(first, { reason: "CAP_REACHED", next_cursor: "p2" }), [print(T - 10, "buy", 11)], ready);
    const page = store.nextRequest(ready)!;
    store.lost(page.request_id + 1);
    expect(store.pending).toBe(true);
    store.lost(page.request_id);
    expect(store.pending).toBe(false);
    expect(store.owns(page.request_id)).toBe(false);
    const again = store.nextRequest(ready)!;
    expect(again).toMatchObject({ from_ts: T - H, to_ts: T, cursor: "p2" });
    expect(again.request_id).not.toBe(page.request_id);
    store.put(reply(again), [print(T - 20, "sell", 12)], ready);
    expect(store.read(T - H, T, 10, ready)).toMatchObject({ buyCount: 1, sellCount: 1, gaps: [] });
  });

  it("takes only the reply to its own request, for the window and floor it asked", () => {
    const store = anchored();
    const request = store.nextRequest(ready)!;
    expect(store.put({ ...reply(request), request_id: request.request_id + 1_000 }, [], ready)).toBe(false);
    expect(store.put(reply(request, { from_ts: T - 2 * H }), [], ready)).toBe(false);
    expect(store.put(reply(request, { to_ts: T - 1 }), [], ready)).toBe(false);
    expect(store.put(reply(request, { min_size: 11 }), [], ready)).toBe(false);
    expect(store.pending).toBe(true);
    expect(store.put(reply(request), [], ready)).toBe(true);
    expect(store.put(reply(request), [], ready)).toBe(false);
  });

  it("on a reconnect drops its live prints and its request but keeps what it recorded, and sets the cut again after the newest print seen since", () => {
    const store = anchored(T - H, T + H);
    const request = store.nextRequest(ready)!;
    store.put(reply(request), [print(T - 100, "sell", 40)], ready);
    store.addTrade(print(T + 10, "buy", 25));
    const pending = new RangePrintStore();
    pending.markSeen(T - 1);
    pending.setWant({ from: T - H, to: T, floor: 10 }, T);
    pending.nextRequest(ready);
    pending.reanchor();
    expect(pending.pending).toBe(false);
    store.reanchor();
    expect(store.liveFrom).toBeNull();
    expect(store.liveCount).toBe(0);
    expect(store.nextRequest(ready + 1)).toBeNull();
    expect(store.read(T - H, T + H, 10, ready)).toMatchObject({ sellCount: 1, buyCount: 0, gaps: [{ from: T, to: T + H }], loading: true });
    store.markSeen(T + 50);
    store.setWant({ from: T - H, to: T + H, floor: 10 }, T + 60);
    expect(store.liveFrom).toBe(T + 51);
    expect(store.nextRequest(T + 60 + RANGE_ASK_DELAY_MS - 1)).toBeNull();
    expect(store.nextRequest(T + 60 + RANGE_ASK_DELAY_MS)).toMatchObject({ from_ts: T, to_ts: T + 51 });
  });

  it("hands the older half of its live prints over to the recording once it holds more than its live limit", () => {
    expect(MAX_LIVE_PRINTS).toBe(200_000);
    const store = new RangePrintStore({ maxLive: 4 });
    store.setWant({ from: T - H, to: T + H, floor: 1 }, T);
    for (let i = 0; i < 5; i += 1) store.addTrade(print(T + i * 1_000, "buy", 2));
    expect(store.liveCount).toBe(3);
    expect(store.liveFrom).toBe(T + 2_000);
    expect(store.gaps()).toEqual([{ from: T - H, to: T + 2_000 }]);
    expect(store.read(T, T + H, 1, T)).toMatchObject({ buyCount: 3, buyVolume: 6, gaps: [{ from: T, to: T + 2_000 }] });
    const flat = new RangePrintStore({ maxLive: 2 });
    flat.setWant({ from: T - H, to: T + H, floor: 1 }, T);
    for (let i = 0; i < 3; i += 1) flat.addTrade(print(T, "sell", 2));
    expect([flat.liveFrom, flat.liveCount]).toEqual([T + 1, 0]);
  });

  it("forgets the recorded pieces farthest from the window once it holds more than its limit, and stops asking when the window alone needs more", () => {
    expect(MAX_RECORDED_PRINTS).toBe(1_000_000);
    const store = new RangePrintStore({ maxRecorded: 3 });
    store.markSeen(T - 1);
    store.setWant({ from: T - 2 * H, to: T, floor: 1 }, T);
    const near = store.nextRequest(ready)!;
    store.put(reply(near), [print(T - 60_000, "buy", 5), print(T - 30_000, "buy", 5)], ready);
    store.setWant({ from: T - 10 * H, to: T - 8 * H, floor: 1 }, ready);
    const far = store.nextRequest(ready)!;
    expect([far.from_ts, far.to_ts]).toEqual([T - 10 * H, T - 8 * H]);
    store.put(reply(far), [print(T - 9 * H, "sell", 5), print(T - 9 * H + 1, "sell", 5)], ready);
    expect(store.recordedCount).toBe(2);
    expect(store.read(T - 2 * H, T, 1, ready)).toMatchObject({ buyCount: 0, gaps: [{ from: T - 2 * H, to: T }] });
    store.setWant({ from: T - 20 * H, to: T - 8 * H, floor: 1 }, ready);
    const wide = store.nextRequest(ready)!;
    expect([wide.from_ts, wide.to_ts]).toEqual([T - 16 * H, T - 10 * H]);
    store.put(reply(wide), [print(T - 12 * H, "buy", 5), print(T - 11 * H, "buy", 5)], ready);
    expect(store.recordedCount).toBe(4);
    expect(store.nextRequest(ready)).toBeNull();
    expect(store.read(T - 20 * H, T - 8 * H, 1, ready)).toMatchObject({ buyCount: 2, sellCount: 2, gaps: [{ from: T - 20 * H, to: T - 16 * H }], loading: false });
    store.setWant({ from: T - 21 * H, to: T - 8 * H, floor: 1 }, ready);
    expect(store.nextRequest(ready)).toBeNull();
    store.setWant({ from: T - 21 * H + 1_000, to: T - 8 * H + 1_000, floor: 1 }, ready);
    expect(store.nextRequest(ready)).toBeNull();
    store.setWant({ from: T - 21 * H, to: T - 12 * H, floor: 1 }, ready);
    expect(store.recordedCount).toBe(2);
    expect(store.nextRequest(ready)).toMatchObject({ from_ts: T - 21 * H, to_ts: T - 16 * H });
  });

  it("tells what a range still needs without walking a print: the gaps, and loading while one is still to be asked", () => {
    const store = anchored(T - 12 * H, T, 1);
    expect(store.coverage(T - 6 * H, T + H, 1, ready)).toEqual({ gaps: [{ from: T - 6 * H, to: T }], loading: true });
    expect(store.coverage(T - 6 * H, T + H, 0.5, ready)).toEqual({ gaps: [{ from: T - 6 * H, to: T + H }], loading: true });
    expect(store.coverage(T, T, 1, ready)).toBeNull();
    const ask = store.nextRequest(ready)!;
    store.put(reply(ask), [print(T - 60_000, "buy", 5)], ready);
    expect(store.coverage(T - 6 * H, T + H, 1, ready)).toEqual({ gaps: [], loading: false });
    expect(store.coverage(T - 12 * H, T + H, 2, ready)).toEqual({ gaps: [{ from: T - 12 * H, to: T - 6 * H }], loading: true });
    expect(store.read(T - 6 * H, T + H, 1, ready)).toEqual({ buyCount: 1, buyVolume: 5, sellCount: 0, sellVolume: 0, gaps: [], loading: false });
    expect(new RangePrintStore().coverage(T - H, T, 1, ready)).toEqual({ gaps: [{ from: T - H, to: T }], loading: true });
  });

  it("asks nothing once its want is dropped, keeps what it recorded, and asks again at the next want", () => {
    const store = anchored(T - 12 * H, T, 1);
    const first = store.nextRequest(ready)!;
    expect([first.from_ts, first.to_ts]).toEqual([T - 6 * H, T]);
    store.put(reply(first), [print(T - 60_000, "buy", 5)], ready);
    store.dropWant();
    expect(store.nextRequest(ready)).toBeNull();
    expect(store.gaps()).toEqual([]);
    expect(store.read(T - 6 * H, T, 1, ready)).toMatchObject({ buyCount: 1, gaps: [] });
    store.setWant({ from: T - 12 * H, to: T, floor: 1 }, ready);
    expect(store.nextRequest(ready)).toMatchObject({ from_ts: T - 12 * H, to_ts: T - 6 * H });
  });

  it("sends at most RANGE_ASK_BUDGET requests in any RANGE_ASK_BUDGET_MS, so Aggressive Orders keeps room in the host's budget for the connection", () => {
    expect([RANGE_ASK_BUDGET, RANGE_ASK_BUDGET_MS]).toEqual([40, 60_000]);
    const store = anchored(T - 1_000 * H, T, 1);
    for (let i = 0; i < RANGE_ASK_BUDGET; i += 1) {
      const ask = store.nextRequest(ready + i);
      expect(ask).not.toBeNull();
      store.put(reply(ask!), [], ready + i);
    }
    expect(store.nextRequest(ready + RANGE_ASK_BUDGET)).toBeNull();
    expect(store.nextRequest(ready + RANGE_ASK_BUDGET_MS - 1)).toBeNull();
    expect(store.nextRequest(ready + RANGE_ASK_BUDGET_MS)).not.toBeNull();
  });

  it("with nothing seen before its first want cuts at the clock, and asks the recording only once the feed has passed the cut, so a lagging feed's late prints come from the recording", () => {
    const store = new RangePrintStore();
    store.setWant({ from: T - H, to: T, floor: 1 }, T);
    expect(store.liveFrom).toBe(T);
    expect(store.addTrade(print(T - 90_000, "buy", 5))).toBe(false);
    expect(store.nextRequest(ready)).toBeNull();
    expect(store.addTrade(print(T - 1, "buy", 5))).toBe(false);
    expect(store.nextRequest(ready + 1_000)).toBeNull();
    expect(store.addTrade(print(T, "sell", 5))).toBe(true);
    expect(store.nextRequest(ready + 2_000)).toMatchObject({ from_ts: T - H, to_ts: T });
    const quiet = new RangePrintStore();
    quiet.setWant({ from: T - H, to: T, floor: 1 }, T);
    expect(quiet.nextRequest(ready)).toMatchObject({ from_ts: T - H, to_ts: T });
    const seen = new RangePrintStore();
    seen.markSeen(T - 90_000);
    seen.setWant({ from: T - H, to: T, floor: 1 }, T);
    expect(seen.liveFrom).toBe(T - 89_999);
    expect(seen.nextRequest(ready)).toMatchObject({ from_ts: T - H, to_ts: T - 89_999 });
  });

  it("tells its listeners when what it recorded changes, never for a live print or a window that only moved", () => {
    const store = new RangePrintStore();
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    store.setWant({ from: T - H, to: T, floor: 10 }, T);
    expect(listener).toHaveBeenCalledTimes(1);
    store.addTrade(print(T + 1, "buy", 20));
    store.setWant({ from: T - 2 * H, to: T, floor: 10 }, T);
    expect(listener).toHaveBeenCalledTimes(1);
    const request = store.nextRequest(ready)!;
    store.put(reply(request), [], ready);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    store.reanchor();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.version).toBe(3);
  });
});

describe("RangePrintStore live listeners", () => {
  it("tells its live listeners each live print it keeps, with its time, size and side, never a print under the floor or before the cut, and nothing once unsubscribed", () => {
    const store = anchored(T - H, T + H);
    const heard: unknown[] = [];
    const stop = store.subscribeLive((print) => heard.push(print));
    const version = store.version;
    store.addTrade(print(T + 10, "buy", 25));
    store.addTrade(print(T + 20, "sell", 9));
    store.addTrade(print(T - 10, "sell", 30));
    store.addTrade(print(T + 30, "sell", 11));
    expect(heard).toEqual([{ ts: T + 10, size: 25, buy: true }, { ts: T + 30, size: 11, buy: false }]);
    expect(store.version).toBe(version);
    stop();
    store.addTrade(print(T + 40, "buy", 12));
    expect(heard).toHaveLength(2);
  });
});

describe("RangePrintStore.readCandles", () => {
  const sortedCandles = (candles: ReadonlyMap<number, unknown>) => [...candles.entries()].sort((a, b) => a[0] - b[0]);
  const every = (from: number, intervalMs: number, count: number): CandleSlot[] => Array.from({ length: count }, (_, i) => ({ ts_open: from + i * intervalMs, interval_ms: intervalMs }));

  function recorded(): RangePrintStore {
    const store = anchored(T - H, T + H);
    const request = store.nextRequest(ready)!;
    store.put(reply(request), [print(T - 100, "sell", 40), print(T - 50, "buy", 12), print(T - 30, "buy", 15)], ready);
    store.addTrade(print(T + 10, "buy", 25));
    store.addTrade(print(T + 20, "sell", 9));
    store.addTrade(print(T + 30, "sell", 11));
    return store;
  }

  it("puts every recorded and live print at or above the floor in the candle its own time falls in, by side, with the same counts, gaps and loading as read", () => {
    const store = recorded();
    const read = store.readCandles(T - H, T + H, 10, every(T - 200, 50, 10), ready)!;
    expect(sortedCandles(read.candles)).toEqual([[T - 100, tally(0, 0, 1, 40)], [T - 50, tally(2, 27, 0, 0)], [T, tally(1, 25, 1, 11)]]);
    expect({ ...read, candles: undefined }).toEqual({ ...store.read(T - H, T + H, 10, ready), candles: undefined });
    expect(sortedCandles(store.readCandles(T - H, T + H, 10, every(T - 1_000, 1_000, 3), ready)!.candles)).toEqual([[T - 1_000, tally(2, 27, 1, 40)], [T, tally(1, 25, 1, 11)]]);
  });

  it("counts only the prints inside the range, and a print before the first candle or in a hole between candles counts nothing", () => {
    const store = recorded();
    const read = store.readCandles(T - 60, T + 15, 10, every(T - 200, 50, 10), ready)!;
    expect(sortedCandles(read.candles)).toEqual([[T - 50, tally(2, 27, 0, 0)], [T, tally(1, 25, 0, 0)]]);
    expect(read.gaps).toEqual([]);
    expect(sortedCandles(store.readCandles(T - H, T - 60, 10, every(T - 200, 50, 10), ready)!.candles)).toEqual([[T - 100, tally(0, 0, 1, 40)]]);
    expect(sortedCandles(store.readCandles(T - H, T + H, 10, [{ ts_open: T - 50, interval_ms: 20 }, { ts_open: T + 25, interval_ms: 10 }], ready)!.candles)).toEqual([[T - 50, tally(1, 12, 0, 0)], [T + 25, tally(0, 0, 1, 11)]]);
    expect(store.readCandles(T - H, T + H, 10, [], ready)!.candles).toEqual(new Map());
  });

  it("adds up the recorded pieces and the live prints that share a candle, both sides", () => {
    const store = anchored(T - 8 * H, T);
    const newest = store.nextRequest(ready)!;
    store.put(reply(newest), [print(T - H, "buy", 10), print(T - H + 1, "sell", 20)], ready);
    const older = store.nextRequest(ready + 1)!;
    store.put(reply(older), [print(T - 7 * H, "buy", 30), print(T - 7 * H + 1, "sell", 40)], ready + 1);
    store.addTrade(print(T + 5, "buy", 50));
    expect(sortedCandles(store.readCandles(T - 8 * H, T + H, 10, [{ ts_open: T - 8 * H, interval_ms: 9 * H }], ready + 2)!.candles)).toEqual([[T - 8 * H, tally(3, 90, 2, 60)]]);
  });

  it("at a lower floor gives no candles and the whole range as a gap still loading, and nothing for an empty range", () => {
    const store = recorded();
    expect(store.readCandles(T - H, T + H, 5, every(T - 200, 50, 10), ready)).toEqual({ ...tally(0, 0, 0, 0), gaps: [{ from: T - H, to: T + H }], loading: true, candles: new Map() });
    expect(store.readCandles(T, T, 10, every(T - 200, 50, 10), ready)).toBeNull();
  });

  it("at a higher floor counts only the recorded and live prints at or above it, a whole piece print by print, with the same gaps", () => {
    const store = recorded();
    const slots = every(T - 200, 50, 10);
    const big = store.readCandles(T - H, T + H, 20, slots, ready)!;
    expect(sortedCandles(big.candles)).toEqual([[T - 100, tally(0, 0, 1, 40)], [T, tally(1, 25, 0, 0)]]);
    expect({ ...big, candles: undefined }).toEqual({ ...tally(1, 25, 1, 40), gaps: [], loading: false, candles: undefined });
    expect(store.read(T - H, T + H, 20, ready)).toEqual({ ...tally(1, 25, 1, 40), gaps: [], loading: false });
    expect(store.read(T - 60, T + 25, 15, ready)).toEqual({ ...tally(2, 40, 0, 0), gaps: [], loading: false });
    expect(store.read(T - H, T + H, 10, ready)).toEqual({ ...tally(3, 52, 2, 51), gaps: [], loading: false });
  });

  it("keeps each live print's time through the hand-over to the recording and forgets it on a reconnect", () => {
    const store = new RangePrintStore({ maxLive: 4 });
    store.setWant({ from: T - H, to: T + H, floor: 1 }, T);
    for (let i = 0; i < 5; i += 1) store.addTrade(print(T + i * 1_000, "buy", 2));
    expect(sortedCandles(store.readCandles(T, T + H, 1, every(T, 1_000, 30), T)!.candles)).toEqual([[T + 2_000, tally(1, 2, 0, 0)], [T + 3_000, tally(1, 2, 0, 0)], [T + 4_000, tally(1, 2, 0, 0)]]);
    store.reanchor();
    store.setWant({ from: T - H, to: T + H, floor: 1 }, T + 10_000);
    store.addTrade(print(T + 20_000, "sell", 3));
    expect(sortedCandles(store.readCandles(T, T + H, 1, every(T, 1_000, 30), T + 20_000)!.candles)).toEqual([[T + 20_000, tally(0, 0, 1, 3)]]);
  });
});
