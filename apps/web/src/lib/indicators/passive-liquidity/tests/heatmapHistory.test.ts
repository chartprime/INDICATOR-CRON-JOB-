import { describe, expect, it, vi } from "vitest";
import { HeatmapHistory, type HistoryRequest } from "../heatmapHistory";
import { HISTORY_WINDOW_MS, type DecodedHistoryPage } from "../heatmapHistoryDecode";
import { InFlightPool } from "../requestBudget";
import type { LiquidityColumn } from "../liquidityGrid";

const W = HISTORY_WINDOW_MS;
const T0 = Math.floor(1_757_340_000_000 / W) * W;
const BTC = { provider: "BINANCE" as const, marketKind: "PERPETUAL", symbol: "BTCUSDT" };

function column(ts: number, rows = 4): LiquidityColumn {
  return { ts, lo: 100, hi: 100 + rows - 1, bid: new Float64Array(rows).fill(1), ask: new Float64Array(rows) };
}

function page(request: HistoryRequest, { skip = [] as number[], next = null as number | null, rowWidth = 4, levelMs = request.levelMs, generation = "generation-a", span = { oldest: T0 - 100 * W, newest: T0 + 100 * W } } = {}): DecodedHistoryPage {
  const windows = [];
  for (let ts = request.fromTs; ts < (next ?? request.toTs); ts += W) {
    if (skip.includes(ts)) continue;
    windows.push({ ts, state: "COVERED" as const, columns: Array.from({ length: W / levelMs }, (_, i) => column(ts + i * levelMs)) });
  }
  return { available: true, generation, levelMs, rowFactor: request.rowFactor, rowWidth, span, next, windows };
}

function harness(options: Partial<ConstructorParameters<typeof HeatmapHistory>[0]> = {}) {
  const requests: HistoryRequest[] = [];
  let now = 1_000_000;
  const history = new HeatmapHistory({ request: (request) => requests.push(request), now: () => now, ...options });
  history.setIdentity(BTC);
  return { history, requests, advance: (ms: number) => { now += ms; } };
}

describe("HeatmapHistory.reach", () => {
  const DAY = 86_400_000;
  const H = 3_600_000;
  const wide = { span: { oldest: T0 - 10 * DAY, newest: T0 + 100 * W } };
  const settle = (history: HeatmapHistory, requests: HistoryRequest[], answer: (request: HistoryRequest) => DecodedHistoryPage | null) => {
    const done = new Set<number>();
    for (let round = 0; round < 200 && requests.some((r) => !done.has(r.requestId)); round += 1) {
      for (const request of requests.filter((r) => !done.has(r.requestId))) {
        done.add(request.requestId);
        const reply = answer(request);
        if (reply === null) history.fail(request.requestId);
        else history.accept(request.requestId, reply);
      }
    }
  };

  it("asks for a reach in chunks no longer than the request span, newest first, and shows nothing until every window has answered", () => {
    const { history, requests } = harness({ maxInFlight: 100, maxPerMinute: 1_000 });
    const want = { levelMs: 60_000, rowFactor: 1, fromTs: T0 - DAY, toTs: T0, beforeTs: T0 };
    const first = history.reach(want);
    expect(first).toMatchObject({ loading: true, shown: null });
    expect(first.columns).toHaveLength(0);
    expect(requests).toHaveLength(8);
    expect(requests[0]).toMatchObject({ fromTs: T0 - 3 * H, toTs: T0 });
    for (let i = 1; i < requests.length; i += 1) expect(requests[i].toTs).toBe(requests[i - 1].fromTs);
    expect(requests.every((r) => r.toTs - r.fromTs <= 3 * H)).toBe(true);
    for (const request of requests.slice(0, 7)) history.accept(request.requestId, page(request, wide));
    expect(history.reach(want)).toMatchObject({ loading: true, shown: null });
    history.accept(requests[7].requestId, page(requests[7], wide));
    const whole = history.reach(want);
    expect(whole.loading).toBe(false);
    expect(whole.shown).toEqual(want);
    expect(whole.columns).toHaveLength(DAY / 60_000);
    expect(whole.columns[0].ts).toBe(T0 - DAY);
    expect(whole.columns[whole.columns.length - 1].ts).toBe(T0 - 60_000);
  });

  it("keeps the reach on screen while a longer one loads, swaps once it is whole, and a failed or unbuilt window does not hold the swap back", () => {
    const { history, requests } = harness({ maxInFlight: 100, maxPerMinute: 1_000 });
    const day = { levelMs: 60_000, rowFactor: 1, fromTs: T0 - DAY, toTs: T0, beforeTs: T0 };
    history.reach(day);
    settle(history, requests, (r) => page(r, wide));
    const dayShown = history.reach(day);
    expect(dayShown.loading).toBe(false);
    const dayColumns = dayShown.columns;
    const week = { levelMs: 300_000, rowFactor: 1, fromTs: T0 - 7 * DAY, toTs: T0, beforeTs: T0 };
    const asked = history.reach(week);
    expect(asked.loading).toBe(true);
    expect(asked.shown).toEqual(day);
    expect(asked.columns).toBe(dayColumns);
    const weekRequests = requests.slice(8);
    expect(weekRequests.length).toBeGreaterThan(50);
    settle(history, weekRequests, (r) => (r.fromTs === T0 - 7 * DAY ? null : page(r, { ...wide, skip: [r.fromTs] })));
    const landed = history.reach(week);
    expect(landed.loading).toBe(false);
    expect(landed.shown).toEqual(week);
    expect(landed.columns.length).toBeGreaterThan(1_500);
    expect(landed.columns.every((column) => column.ts >= T0 - 7 * DAY && column.ts < T0)).toBe(true);
  });

  it("a reach of the same length that slides with the live edge fills in quietly, without a loading state", () => {
    const { history, requests } = harness({ maxInFlight: 100, maxPerMinute: 1_000 });
    const day = { levelMs: 60_000, rowFactor: 1, fromTs: T0 - DAY, toTs: T0, beforeTs: T0 };
    history.reach(day);
    settle(history, requests, (r) => page(r, wide));
    expect(history.reach(day).shown).toEqual(day);
    const slid = { ...day, fromTs: T0 - DAY + W, toTs: T0 + W, beforeTs: T0 + W };
    const sliding = history.reach(slid);
    expect(sliding.loading).toBe(false);
    expect(sliding.shown).toEqual(day);
    settle(history, requests, (r) => page(r, wide));
    expect(history.reach(slid).shown).toEqual(slid);
  });

  it("keeps the reach on screen within its byte budget while other windows come and go", () => {
    const perWindow = 256 + (W / 60_000) * 2 * 4 * 8;
    const dayBytes = (DAY / W) * perWindow;
    const { history, requests, advance } = harness({ maxInFlight: 100, maxPerMinute: 1_000, maxBytes: dayBytes + 256 + 30 * 2 * 4 * 8 });
    const day = { levelMs: 60_000, rowFactor: 1, fromTs: T0 - DAY, toTs: T0, beforeTs: T0 };
    history.reach(day);
    settle(history, requests, (r) => page(r, wide));
    expect(history.reach(day).columns).toHaveLength(DAY / 60_000);
    advance(1_000);
    const elsewhere = { levelMs: 10_000, rowFactor: 1, fromTs: T0 + 10 * W, toTs: T0 + 13 * W, beforeTs: Infinity };
    history.want(elsewhere);
    settle(history, requests, (r) => page(r, wide));
    expect(history.columns(elsewhere)).toHaveLength(90);
    const again = history.reach(day);
    expect(again.loading).toBe(false);
    expect(again.columns).toHaveLength(DAY / 60_000);
  });

  it("a new pair forgets what was shown", () => {
    const { history, requests } = harness({ maxInFlight: 100, maxPerMinute: 1_000 });
    const day = { levelMs: 60_000, rowFactor: 1, fromTs: T0 - DAY, toTs: T0, beforeTs: T0 };
    history.reach(day);
    settle(history, requests, (r) => page(r, wide));
    expect(history.reach(day).shown).toEqual(day);
    history.setIdentity({ ...BTC, symbol: "ETHUSDT" });
    expect(history.reach(day)).toMatchObject({ loading: true, shown: null });
  });
});

describe("HeatmapHistory", () => {
  it("asks for the missing span newest first within two requests at a time, and never asks twice for what is on the way", () => {
    const { history, requests } = harness({ maxInFlight: 2 });
    history.want({ levelMs: 30_000, rowFactor: 1, fromTs: T0, toTs: T0 + 6 * W, beforeTs: T0 + 4 * W });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ identity: BTC, levelMs: 30_000, rowFactor: 1, fromTs: T0, toTs: T0 + 4 * W });
    history.want({ levelMs: 30_000, rowFactor: 1, fromTs: T0, toTs: T0 + 6 * W, beforeTs: T0 + 4 * W });
    expect(requests).toHaveLength(1);
    history.want({ levelMs: 300_000, rowFactor: 2, fromTs: T0 - 3 * W, toTs: T0, beforeTs: T0 + 4 * W });
    history.want({ levelMs: 60_000, rowFactor: 1, fromTs: T0 - 3 * W, toTs: T0, beforeTs: T0 + 4 * W });
    expect(requests).toHaveLength(2);
    expect(history.inFlight).toBe(2);
  });

  it("holds an answer's windows and hands back only the columns older than the live grid, in order, the same array while nothing changes", () => {
    const { history, requests } = harness();
    const want = { levelMs: 60_000, rowFactor: 1, fromTs: T0, toTs: T0 + 3 * W, beforeTs: T0 + 2 * W + 90_000 };
    history.want(want);
    history.accept(requests[0].requestId, page(requests[0]));
    expect(requests[0].toTs).toBe(T0 + 3 * W);
    const columns = history.columns(want);
    expect(columns.map((c) => c.ts)).toEqual(Array.from({ length: 12 }, (_, i) => T0 + i * 60_000));
    expect(history.columns(want)).toBe(columns);
    expect(history.status(60_000, 1)).toMatchObject({ rowWidth: 4, reachTs: T0, unavailable: null });
  });

  it("follows a page's next to the end of the request, and does not ask again for windows the host has not built until the retry delay", () => {
    const { history, requests, advance } = harness({ retryMs: 30_000 });
    const want = { levelMs: 300_000, rowFactor: 1, fromTs: T0, toTs: T0 + 6 * W, beforeTs: Infinity };
    history.want(want);
    history.accept(requests[0].requestId, page(requests[0], { next: T0 + 3 * W, skip: [T0 + W] }));
    expect(requests[1]).toMatchObject({ fromTs: T0 + 3 * W, toTs: T0 + 6 * W });
    history.accept(requests[1].requestId, page(requests[1]));
    history.want(want);
    expect(requests).toHaveLength(2);
    advance(30_000);
    history.want(want);
    expect(requests[2]).toMatchObject({ fromTs: T0 + W, toTs: T0 + 2 * W });
  });

  it("an unavailable answer pauses that level until the retry delay; a failed request frees its windows for a retry later", () => {
    const { history, requests, advance } = harness({ retryMs: 10_000 });
    const want = { levelMs: 10_000, rowFactor: 1, fromTs: T0, toTs: T0 + W, beforeTs: Infinity };
    history.want(want);
    history.accept(requests[0].requestId, { available: false, reason: "NO_PYRAMID" });
    expect(history.status(10_000, 1).unavailable).toBe("NO_PYRAMID");
    history.want(want);
    expect(requests).toHaveLength(1);
    advance(10_000);
    history.want(want);
    expect(requests).toHaveLength(2);
    history.fail(requests[1].requestId);
    history.want(want);
    expect(requests).toHaveLength(2);
    advance(10_000);
    history.want(want);
    expect(requests).toHaveLength(3);
  });

  it("asks again after the delay the host named when it was busy, and after the long retry for a failure it gave no delay for", () => {
    const { history, requests, advance } = harness({ retryMs: 30_000 });
    const want = { levelMs: 10_000, rowFactor: 1, fromTs: T0, toTs: T0 + W, beforeTs: Infinity };
    history.want(want);
    history.fail(requests[0].requestId, 250);
    advance(1_900);
    history.want(want);
    expect(requests).toHaveLength(1);
    advance(200);
    history.want(want);
    expect(requests).toHaveLength(2);
    history.fail(requests[1].requestId);
    advance(20_000);
    history.want(want);
    expect(requests).toHaveLength(2);
    advance(10_000);
    history.want(want);
    expect(requests).toHaveLength(3);
  });

  it("a window the host failed to build is not kept as a hole: it is asked for again after ten minutes and taken when rebuilt (closure audit)", () => {
    const { history, requests, advance } = harness({ retryMs: 30_000 });
    const want = { levelMs: 300_000, rowFactor: 1, fromTs: T0, toTs: T0 + W, beforeTs: Infinity };
    history.want(want);
    const failed = page(requests[0]);
    if (!failed.available) throw new Error("expected a page");
    failed.windows[0] = { ts: T0, state: "FAILED", columns: [] };
    history.accept(requests[0].requestId, failed);
    expect(history.bytes).toBe(0);
    advance(30_000);
    history.want(want);
    expect(requests).toHaveLength(1);
    advance(10 * 60_000);
    history.want(want);
    expect(requests).toHaveLength(2);
    history.accept(requests[1].requestId, page(requests[1]));
    expect(history.columns(want)).toHaveLength(1);
  });

  it("rechecks a settled empty window and replaces it when delayed capture is published", () => {
    const { history, requests, advance } = harness();
    const want = { levelMs: 300_000, rowFactor: 1, fromTs: T0, toTs: T0 + W, beforeTs: Infinity };
    history.want(want);
    const empty = page(requests[0]);
    if (!empty.available) throw new Error("expected a page");
    empty.windows[0] = { ts: T0, state: "NO_DATA", columns: [] };
    history.accept(requests[0].requestId, empty);
    advance(9 * 60_000);
    history.want(want);
    expect(requests).toHaveLength(1);
    advance(60_000);
    history.want(want);
    expect(requests).toHaveLength(2);
    history.accept(requests[1].requestId, page(requests[1]));
    expect(history.columns(want)).toHaveLength(1);
  });

  it("retries an unavailable stationary view when its delay expires without another chart event", () => {
    vi.useFakeTimers();
    try {
      let now = 1_000_000;
      const requests: HistoryRequest[] = [];
      const history = new HeatmapHistory({ request: (request) => requests.push(request), now: () => now, retryMs: 10_000 });
      const want = { levelMs: 10_000, rowFactor: 1, fromTs: T0, toTs: T0 + W, beforeTs: Infinity };
      history.setIdentity(BTC);
      const unsubscribe = history.subscribe(() => history.want(want));
      history.want(want);
      history.accept(requests[0].requestId, { available: false, reason: "NO_PYRAMID" });
      expect(requests).toHaveLength(1);
      now += 10_000;
      vi.advanceTimersByTime(10_000);
      expect(requests).toHaveLength(2);
      unsubscribe();
      history.setIdentity(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discovers older pyramid windows built after the first response without reloading a stationary chart", () => {
    vi.useFakeTimers();
    try {
      let now = 1_000_000;
      const requests: HistoryRequest[] = [];
      const history = new HeatmapHistory({ request: (request) => requests.push(request), now: () => now });
      const want = { levelMs: 300_000, rowFactor: 1, fromTs: T0 - W, toTs: T0 + W, beforeTs: Infinity };
      history.setIdentity(BTC);
      history.want({ ...want, fromTs: T0 });
      const first = page(requests[0]);
      if (!first.available) throw new Error("expected a page");
      first.span = { oldest: T0, newest: T0 };
      history.accept(requests[0].requestId, first);
      history.subscribe(() => history.want(want));
      history.want(want);
      expect(requests).toHaveLength(1);
      now += 60_000;
      vi.advanceTimersByTime(60_000);
      expect(requests[1]).toMatchObject({ fromTs: T0 - W, toTs: T0 });
      const expanded = page(requests[1]);
      if (!expanded.available) throw new Error("expected a page");
      expanded.span = { oldest: T0 - W, newest: T0 };
      history.accept(requests[1].requestId, expanded);
      expect(history.columns(want).map((column) => column.ts)).toEqual([T0 - W, T0]);
      now += 60_000;
      vi.advanceTimersByTime(60_000);
      expect(requests).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wakes a deferred span probe after its request budget renews", () => {
    vi.useFakeTimers();
    try {
      let now = 1_000_000;
      const requests: HistoryRequest[] = [];
      const history = new HeatmapHistory({ request: (request) => requests.push(request), now: () => now, maxPerMinute: 1 });
      const want = { levelMs: 300_000, rowFactor: 1, fromTs: T0 - W, toTs: T0 + W, beforeTs: Infinity };
      history.setIdentity(BTC);
      history.want({ ...want, fromTs: T0 });
      const first = page(requests[0]);
      if (!first.available) throw new Error("expected a page");
      first.span = { oldest: T0, newest: T0 };
      history.accept(requests[0].requestId, first);
      now += 60_000;
      vi.advanceTimersByTime(60_000);
      history.want({ ...want, levelMs: 60_000, fromTs: T0 });
      expect(requests).toHaveLength(2);
      history.accept(requests[1].requestId, page(requests[1]));
      history.subscribe(() => history.want(want));
      history.want(want);
      expect(requests).toHaveLength(2);
      now += 60_000;
      vi.advanceTimersByTime(60_000);
      expect(requests[2]).toMatchObject({ fromTs: T0 - W, toTs: T0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes an old covered view and drops every stale page and late answer after a host re-pin", () => {
    const { history, requests, advance } = harness();
    const first = { levelMs: 300_000, rowFactor: 1, fromTs: T0, toTs: T0 + W, beforeTs: Infinity };
    const second = { ...first, fromTs: T0 + W, toTs: T0 + 2 * W };
    history.want(first);
    history.accept(requests[0].requestId, page(requests[0]));
    history.want(second);
    advance(6 * 3_600_000);
    history.want(first);
    expect(requests).toHaveLength(3);
    history.accept(requests[2].requestId, page(requests[2], { generation: "generation-b", rowWidth: 8 }));
    history.accept(requests[1].requestId, page(requests[1], { generation: "generation-a" }));
    expect(history.status(300_000, 1).rowWidth).toBe(8);
    expect(history.columns(first)).toHaveLength(1);
    expect(history.columns(second)).toHaveLength(0);
  });

  it("a new pair drops what was held and ignores answers still on the way", () => {
    const { history, requests } = harness();
    const want = { levelMs: 30_000, rowFactor: 1, fromTs: T0, toTs: T0 + W, beforeTs: Infinity };
    history.want(want);
    history.setIdentity({ provider: "DXFEED", marketKind: "FUTURE", symbol: "/NQZ26:XCME" });
    history.accept(requests[0].requestId, page(requests[0]));
    expect(history.columns(want)).toHaveLength(0);
    expect(history.bytes).toBe(0);
    history.want(want);
    expect(requests[1].identity).toEqual({ provider: "DXFEED", marketKind: "FUTURE", symbol: "/NQZ26:XCME" });
  });

  it("stays within its byte budget by dropping the least recently used windows, never the ones on screen", () => {
    const perWindow = 256 + 30 * 2 * 4 * 8;
    const { history, requests, advance } = harness({ maxBytes: perWindow * 4 });
    const onScreen = { levelMs: 10_000, rowFactor: 1, fromTs: T0 - 10 * W, toTs: T0 - 8 * W, beforeTs: Infinity };
    history.want(onScreen);
    history.accept(requests[0].requestId, page(requests[0]));
    advance(1_000);
    const elsewhere = { levelMs: 10_000, rowFactor: 1, fromTs: T0, toTs: T0 + 3 * W, beforeTs: Infinity };
    history.want(elsewhere);
    history.want(onScreen);
    advance(1_000);
    history.accept(requests[1].requestId, page(requests[1]));
    expect(history.bytes).toBe(4 * perWindow);
    expect(history.columns(onScreen)).toHaveLength(60);
    expect(history.columns(elsewhere)).toHaveLength(60);
  });

  it("a covered window dropped for the byte budget is asked for again when the view returns to it, not held back until the re-pin recheck", () => {
    const perWindow = 256 + 30 * 2 * 4 * 8;
    const { history, requests, advance } = harness({ maxBytes: perWindow * 4 });
    const onScreen = { levelMs: 10_000, rowFactor: 1, fromTs: T0 - 10 * W, toTs: T0 - 8 * W, beforeTs: Infinity };
    const elsewhere = { levelMs: 10_000, rowFactor: 1, fromTs: T0, toTs: T0 + 3 * W, beforeTs: Infinity };
    history.want(onScreen);
    history.accept(requests[0].requestId, page(requests[0]));
    advance(1_000);
    history.want(elsewhere);
    history.want(onScreen);
    advance(1_000);
    history.accept(requests[1].requestId, page(requests[1]));
    expect(history.columns(elsewhere)).toHaveLength(60);
    advance(1_000);
    history.want(elsewhere);
    expect(requests).toHaveLength(3);
    history.accept(requests[2].requestId, page(requests[2]));
    expect(history.columns(elsewhere)).toHaveLength(90);
  });

  it("spends at most its per-minute request budget", () => {
    const { history, requests, advance } = harness({ maxInFlight: 100, maxPerMinute: 3 });
    for (let i = 0; i < 5; i += 1) history.want({ levelMs: 10_000, rowFactor: 1, fromTs: T0 + i * 10 * W, toTs: T0 + i * 10 * W + W, beforeTs: Infinity });
    expect(requests).toHaveLength(3);
    advance(60_000);
    history.want({ levelMs: 10_000, rowFactor: 1, fromTs: T0 + 40 * W, toTs: T0 + 41 * W, beforeTs: Infinity });
    expect(requests).toHaveLength(4);
  });

  it("pagination also obeys the per-minute budget and resumes when it resets", () => {
    const { history, requests, advance } = harness({ maxPerMinute: 1 });
    const want = { levelMs: 300_000, rowFactor: 1, fromTs: T0, toTs: T0 + 2 * W, beforeTs: Infinity };
    history.want(want);
    history.accept(requests[0].requestId, page(requests[0], { next: T0 + W }));
    expect(requests).toHaveLength(1);
    history.want(want);
    expect(requests).toHaveLength(1);
    advance(60_000);
    history.want(want);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ fromTs: T0 + W, toTs: T0 + 2 * W });
  });

  it("waits for a slot of the route's pool another reader holds, and wakes a stationary chart within a second of one freeing (PR #47 review)", () => {
    vi.useFakeTimers();
    try {
      const pool = new InFlightPool(2);
      pool.take();
      pool.take();
      const requests: HistoryRequest[] = [];
      const history = new HeatmapHistory({ request: (request) => requests.push(request), now: () => 1_000_000, pool });
      const want = { levelMs: 300_000, rowFactor: 1, fromTs: T0, toTs: T0 + 2 * W, beforeTs: Infinity };
      history.setIdentity(BTC);
      history.subscribe(() => history.want(want));
      history.want(want);
      expect(requests).toHaveLength(0);
      pool.free();
      vi.advanceTimersByTime(1_000);
      expect(requests).toHaveLength(1);
      expect(pool.held).toBe(2);
      history.accept(requests[0].requestId, page(requests[0]));
      expect(pool.held).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("frees the pool's slots of the answers it will drop: on a host re-pin and on a pair switch (PR #47 review)", () => {
    const pool = new InFlightPool(4);
    const { history, requests } = harness({ pool, requestSpanMs: W });
    const want = { levelMs: 300_000, rowFactor: 1, fromTs: T0, toTs: T0 + 3 * W, beforeTs: Infinity };
    history.want(want);
    expect(requests).toHaveLength(2);
    expect(pool.held).toBe(2);
    history.accept(requests[0].requestId, page(requests[0]));
    expect(pool.held).toBe(1);
    history.want(want);
    expect(requests).toHaveLength(3);
    expect(pool.held).toBe(2);
    history.accept(requests[1].requestId, page(requests[1], { generation: "generation-b" }));
    expect(pool.held).toBe(0);
    history.accept(requests[2].requestId, page(requests[2]));
    expect(pool.held).toBe(0);
    history.want(want);
    expect(pool.held).toBeGreaterThan(0);
    history.setIdentity(null);
    expect(pool.held).toBe(0);
  });

  it("wakes a stationary chart when a spent page budget becomes available", () => {
    vi.useFakeTimers();
    try {
      let now = 1_000_000;
      const requests: HistoryRequest[] = [];
      const history = new HeatmapHistory({ request: (request) => requests.push(request), now: () => now, maxPerMinute: 1 });
      const want = { levelMs: 300_000, rowFactor: 1, fromTs: T0, toTs: T0 + 2 * W, beforeTs: Infinity };
      history.setIdentity(BTC);
      history.subscribe(() => history.want(want));
      history.want(want);
      history.accept(requests[0].requestId, page(requests[0], { next: T0 + W }));
      expect(requests).toHaveLength(1);
      now += 60_000;
      vi.advanceTimersByTime(60_000);
      expect(requests).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
