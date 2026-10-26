import { describe, expect, it, vi } from "vitest";
import { historicalL2, type IndicatorL2 } from "../../../chart/indicatorL2";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import { AbsorptionTracker, readPrint, type AbsorptionRecord, type ColumnFeed } from "../absorptionEngine";
import { EngineAbsorptionTracker, HISTORY_CHUNK_MS, MAX_CHUNK_ATTEMPTS, MAX_PAGES_PER_CHUNK, backfillEventHistory, tradeRow } from "../engineAbsorption";
import { BAND, BAND_MID, HIT_ROW, L2Feed, ROW, RULES, S, STEP, T, col, feedOf, tape } from "./absorptionFixtures";

const run = (engine: EngineAbsorptionTracker, l2: IndicatorL2 | undefined, feed: ColumnFeed, nowMs: number) => {
  const { feed: read, reason } = engine.columns(l2, feed, ROW);
  return { records: reason === null ? new AbsorptionTracker().update(read, ROW, RULES, nowMs) : [], reason };
};

const shape = (records: readonly AbsorptionRecord[]) => records.map((record) => {
  const print = readPrint(record, RULES);
  return [record.side, record.band, record.ts, print?.share ?? null, record.resting, record.absorbed, print?.held ?? null];
});

// The attacks here clear all of the resting size, where an attack is recorded: 240 into a wall of 200.
describe("engine trades into columns: the tracker's rule, fed the engine's trades", () => {
  it("records the sphere when the engine's sells into the band reach all of what it held, and holds it", () => {
    const feed = new L2Feed();
    const tracker = new EngineAbsorptionTracker();
    const columns = tape([{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40 }, { wall: 20 }, { wall: 20 }], 20);
    feed.events([feed.sell(T + 32 * S, 160), feed.sell(T + 45 * S, 80)], { ts: T + 20 * STEP });
    const result = run(tracker, feed.l2, feedOf(columns), T + 19 * STEP + 1);
    expect(result.reason).toBeNull();
    expect(shape(result.records)).toEqual([["bid", BAND, T + 4 * STEP, 1, 200, 240, true]]);
    expect(result.records[0].price).toBe(BAND_MID);
  });

  it("gives exactly the tracker's records when the engine's trades are the column prints", () => {
    const specs = [{ wall: 300 }, { wall: 300 }, { wall: 300 }, { wall: 100, sell: 200 }, { wall: 60, sell: 140 }, ...Array.from({ length: 12 }, () => ({ wall: 60 })), { wall: 10, sell: 70 }, { wall: 10 }];
    const printed = tape(specs, 40);
    const plain = printed.map((column) => ({ ...column, sell: [] as [number, number][] }));
    const feed = new L2Feed();
    feed.events(printed.flatMap((column) => (column.sell ?? []).map(([row, size]) => feed.sell(column.ts + 5 * S, size, row))), { ts: T + 40 * STEP });
    const engine = run(new EngineAbsorptionTracker(), feed.l2, feedOf(plain), T + 39 * STEP + 1).records;
    const tracker = new AbsorptionTracker().update(feedOf(printed), ROW, RULES, T + 39 * STEP + 1);
    expect(engine.length).toBeGreaterThan(1);
    expect(engine).toEqual(tracker);
  });

  it("ignores the column prints once it watches: a band hit only in the columns records nothing on the engine", () => {
    const feed = new L2Feed();
    const tracker = new EngineAbsorptionTracker();
    const columns = tape([{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 240 }, { wall: 40 }], 20);
    feed.tick(T);
    run(tracker, feed.l2, feedOf(columns), T + 1);
    feed.tick(T + 20 * STEP);
    expect(run(tracker, feed.l2, feedOf(columns), T + 19 * STEP + 1).records).toEqual([]);
    expect(new AbsorptionTracker().update(feedOf(columns), ROW, RULES, T + 19 * STEP + 1)).toHaveLength(1);
  });

  it("counts only the attacking side's trades inside the band's rows", () => {
    const feed = new L2Feed();
    const columns = tape([{ wall: 200 }], 20);
    feed.events([feed.sell(T + 32 * S, 240, HIT_ROW + 4), feed.sell(T + 45 * S, 240, BAND * 4 - 1), { ...feed.sell(T + 46 * S, 240), aggressor: "buy", side: "ask" }], { ts: T + 20 * STEP });
    expect(run(new EngineAbsorptionTracker(), feed.l2, feedOf(columns), T + 19 * STEP + 1).records).toEqual([]);
  });

  it("puts a trade on the row its price falls in, a price exactly on a row edge on the row above it", () => {
    expect(tradeRow(80, 4)).toBe(20);
    expect(tradeRow(83.99, 4)).toBe(20);
    expect(tradeRow(0.3, 0.1)).toBe(3);
    expect(tradeRow(30476.25, 0.25)).toBe(121905);
  });
});

describe("engine absorption: what it has watched, and what it has not", () => {
  it("keeps the heatmap's own prints from before it started watching, so the tracker's history shows, and uses the engine's trades from then on", () => {
    const specs = [{ wall: 300 }, { wall: 300 }, { wall: 300 }, { wall: 100, sell: 200 }, { wall: 60, sell: 140 }, ...Array.from({ length: 12 }, () => ({ wall: 60 })), { wall: 10, sell: 70 }, { wall: 10 }];
    const printed = tape(specs, 40);
    const shown = printed.map((column, i) => (i >= 17 ? { ...column, sell: (i === 17 ? [[HIT_ROW, 999]] : []) as [number, number][] } : column));
    const feed = new L2Feed();
    feed.events([feed.sell(printed[17].ts + 5 * S, 70)], { ts: T + 40 * STEP });
    const engine = new EngineAbsorptionTracker();
    const result = run(engine, feed.l2, feedOf(shown), T + 39 * STEP + 1);
    const tracker = new AbsorptionTracker().update(feedOf(printed), ROW, RULES, T + 39 * STEP + 1);
    expect(engine.coveredFrom).toBe(printed[17].ts);
    expect(result.records.filter((record) => record.ts >= printed[17].ts).length).toBeGreaterThan(0);
    expect(result.records).toEqual(tracker);
  });
  it("reads no column the events have not reached yet, so a trade arriving after its column is still counted", () => {
    const feed = new L2Feed();
    const tracker = new EngineAbsorptionTracker();
    const columns = tape([{ wall: 200 }], 20);
    feed.events([feed.sell(T + 32 * S, 80)], { ts: T + 4 * STEP });
    run(tracker, feed.l2, feedOf(columns), T + 19 * STEP + 1);
    feed.events([feed.sell(T + 45 * S, 160)], { ts: T + 20 * STEP });
    const result = run(tracker, feed.l2, feedOf(columns), T + 19 * STEP + 2);
    expect(shape(result.records)).toEqual([["bid", BAND, T + 4 * STEP, 1, 200, 240, true]]);
  });

  it("falls back to the column prints for the stretch the event ring lost, and only there", () => {
    const feed = new L2Feed();
    const tracker = new EngineAbsorptionTracker();
    const columns = tape([{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 200 }, { wall: 40 }, { wall: 40, sell: 90 }, { wall: 40 }], 20);
    feed.events([feed.sell(T + 12 * S, 1)], { ts: T + 2 * STEP });
    run(tracker, feed.l2, feedOf(columns), T + 2 * STEP);
    feed.events([feed.sell(T + 45 * S, 1)], { ts: T + 20 * STEP, missed: 4 });
    const result = run(tracker, feed.l2, feedOf(columns), T + 19 * STEP + 1);
    expect(tracker.gaps).toEqual([[T + 12 * S, T + 45 * S]]);
    expect(shape(result.records)).toEqual([["bid", BAND, T + 3 * STEP, 1, 200, 201, true]]);
  });

  it("folds trades older than the fine tier into the deep tier's columns, so a long session keeps them", () => {
    const feed = new L2Feed();
    const tracker = new EngineAbsorptionTracker();
    feed.events([feed.sell(T + 32 * S, 240)], { ts: T + 5 * STEP });
    run(tracker, feed.l2, feedOf(tape([{ wall: 200 }], 6)), T + 5 * STEP);
    const deepColumns = tape([{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40 }, { wall: 40 }, { wall: 40 }], 10);
    const later: LiquidityColumn[] = Array.from({ length: 20 }, (_, i) => col(T + (10 + i) * STEP, { wall: 40 }));
    feed.tick(T + 30 * STEP);
    const result = run(tracker, feed.l2, { epoch: 1, deep: { columns: deepColumns, columnMs: STEP }, fine: { columns: later, columnMs: STEP } }, T + 29 * STEP + 1);
    expect(shape(result.records)).toEqual([["bid", BAND, T + 3 * STEP, 1, 200, 240, true]]);
  });

  it("counts a folded 10 s bucket once where the tiers meet: a 1 s column takes only its own second, a 10 s column takes the whole bucket", () => {
    const W = T + 10 * STEP;
    const feed = new L2Feed();
    const tracker = new EngineAbsorptionTracker();
    const seconds = (from: number, count: number) => Array.from({ length: count }, (_, i) => col(from + i * S, { wall: 200 }));
    const tiers = (fineFrom: number, deep: LiquidityColumn[]) => ({ epoch: 1, deep: { columns: deep, columnMs: STEP }, fine: { columns: seconds(fineFrom, 10), columnMs: S } });
    feed.events(Array.from({ length: 10 }, (_, i) => feed.sell(W + i * S + 200, 10)), { ts: W + 10 * S });
    run(tracker, feed.l2, tiers(W, []), W + 10 * S);
    feed.tick(W + 15 * S);
    run(tracker, feed.l2, tiers(W + 5 * S, [col(W, { wall: 200 })]), W + 15 * S);
    expect(tracker.tradedInto("sell", HIT_ROW, HIT_ROW, W + 5 * S, W + 6 * S)).toBe(10);
    expect(tracker.tradedInto("sell", HIT_ROW, HIT_ROW, W + 9 * S, W + 10 * S)).toBe(10);
    expect(tracker.tradedInto("sell", HIT_ROW, HIT_ROW, W, W + STEP)).toBe(100);
  });
});

describe("engine absorption: trust and pairs", () => {
  it("says why it cannot read, and hands back no columns to judge", () => {
    const feed = new L2Feed();
    const tracker = new EngineAbsorptionTracker();
    const columns = tape([{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40 }], 20);
    feed.events([feed.sell(T + 32 * S, 240)], { ts: T + 20 * STEP });
    expect(run(tracker, feed.l2, feedOf(columns), T + 19 * STEP + 1).records).toHaveLength(1);
    feed.store.markUntrusted();
    const untrusted = run(tracker, feed.l2, feedOf(columns), T + 19 * STEP + 2);
    expect(untrusted.reason).toBe("untrusted");
    expect(untrusted.records).toEqual([]);
    expect(run(tracker, undefined, feedOf(columns), T).reason).toBe("no-l2");
    expect(run(tracker, historicalL2(), feedOf(columns), T).reason).toBe("historical");
  });

  it("starts over on another pair, and carries on across a new segment of the same pair", () => {
    const columns = tape([{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40 }], 20);
    const feed = new L2Feed();
    const tracker = new EngineAbsorptionTracker();
    feed.events([feed.sell(T + 32 * S, 240)], { ts: T + 20 * STEP });
    run(tracker, feed.l2, feedOf(columns), T + 19 * STEP + 1);
    feed.newSegment({ id: "PERPETUAL:BTCUSDT:9000:LIVE", state: "LIVE" }, T + 20 * STEP);
    expect(run(tracker, feed.l2, feedOf(columns), T + 19 * STEP + 2).records).toHaveLength(1);
    feed.switchPair({ id: "SPOT:ETHUSDT:9000:LIVE", state: "LIVE" }, T + 21 * STEP);
    expect(run(tracker, feed.l2, feedOf(columns), T + 19 * STEP + 3).records).toEqual([]);
  });

  it("backfills the stretch before it started watching from the engine's history, so those columns read the engine's trades instead of the heatmap's prints", () => {
    const specs = [{ wall: 300 }, { wall: 300 }, { wall: 300 }, { wall: 100, sell: 200 }, { wall: 60, sell: 140 }, ...Array.from({ length: 12 }, () => ({ wall: 60 })), { wall: 10, sell: 70 }, { wall: 10 }];
    const printed = tape(specs, 40);
    const shown = printed.map((column) => ({ ...column, sell: [] as [number, number][] }));
    const feed = new L2Feed();
    feed.events([feed.sell(printed[17].ts + 5 * S, 70)], { ts: T + 40 * STEP });
    const engine = new EngineAbsorptionTracker();
    expect(engine.backfill([{ ts: printed[3].ts, columnMs: STEP, row: HIT_ROW, aggressor: "sell", mode: "absorbed", size: 200, count: 1 }], printed[0].ts, printed[17].ts)).toBe(0);
    const before = run(engine, feed.l2, feedOf(shown), T + 39 * STEP + 1);
    expect(engine.coveredFrom).toBe(printed[17].ts);
    expect(before.records.filter((record) => record.ts < printed[17].ts)).toEqual([]);
    const added = engine.backfill([
      { ts: printed[3].ts, columnMs: STEP, row: HIT_ROW, aggressor: "sell", mode: "absorbed", size: 200, count: 1 },
      { ts: printed[4].ts, columnMs: STEP, row: HIT_ROW, aggressor: "sell", mode: "absorbed", size: 140, count: 1 },
      { ts: printed[4].ts, columnMs: 7, row: HIT_ROW, aggressor: "sell", mode: "absorbed", size: 999, count: 1 },
      { ts: printed[20].ts, columnMs: STEP, row: HIT_ROW, aggressor: "sell", mode: "absorbed", size: 999, count: 1 },
    ], printed[3].ts, printed[17].ts);
    expect(added).toBe(2);
    expect(engine.coveredFrom).toBe(printed[3].ts);
    expect(engine.tradedInto("sell", HIT_ROW, HIT_ROW, printed[3].ts, printed[5].ts)).toBe(340);
    const after = run(engine, feed.l2, feedOf(shown), T + 39 * STEP + 1);
    const tracker = new AbsorptionTracker().update(feedOf(printed), ROW, RULES, T + 39 * STEP + 1);
    expect(after.records).toEqual(tracker);
    expect(after.records.some((record) => record.ts < printed[17].ts)).toBe(true);
  });

  it("extends its coverage backwards only with a chunk that reaches the stretch it already covers, so a hole between them is never read as zero traded", () => {
    const printed = tape(Array.from({ length: 20 }, () => ({ wall: 150 })), 40);
    const feed = new L2Feed();
    feed.events([feed.sell(printed[17].ts + 5 * S, 60)], { ts: T + 40 * STEP });
    const engine = new EngineAbsorptionTracker();
    run(engine, feed.l2, feedOf(printed), T + 39 * STEP + 1);
    const sell = (ts: number, size: number) => ({ ts, columnMs: STEP, row: HIT_ROW, aggressor: "sell" as const, mode: "absorbed" as const, size, count: 1 });
    expect(engine.backfill([sell(printed[2].ts, 50)], printed[1].ts, printed[10].ts)).toBe(0);
    expect(engine.coveredFrom).toBe(printed[17].ts);
    expect(engine.backfill([sell(printed[12].ts, 30), sell(printed[18].ts, 999)], printed[10].ts, printed[17].ts)).toBe(1);
    expect(engine.coveredFrom).toBe(printed[10].ts);
    expect(engine.backfill([sell(printed[2].ts, 50), sell(printed[12].ts, 999)], printed[1].ts, printed[10].ts)).toBe(1);
    expect(engine.coveredFrom).toBe(printed[1].ts);
    expect(engine.tradedInto("sell", HIT_ROW, HIT_ROW, printed[1].ts, printed[17].ts)).toBe(80);
  });

  it("asks the history newest first in chunks reaching back from where its own events begin, and stops at a chunk it cannot finish, leaving the older stretch unknown", async () => {
    const printed = tape(Array.from({ length: 20 }, () => ({ wall: 150 })), 40);
    const feed = new L2Feed();
    feed.events([feed.sell(printed[17].ts + 5 * S, 60)], { ts: T + 40 * STEP });
    const engine = new EngineAbsorptionTracker();
    run(engine, feed.l2, feedOf(printed), T + 39 * STEP + 1);
    const start = engine.coveredFrom ?? 0;
    const asked: { fromTs: number; toTs: number; cursor: unknown }[] = [];
    const l2 = {
      ...feed.l2,
      eventHistory: async (range: { fromTs: number; toTs: number }, cursor?: unknown) => {
        asked.push({ fromTs: range.fromTs, toTs: range.toTs, cursor: cursor ?? null });
        const chunk = asked.filter((a) => a.cursor === null).length;
        if (chunk === 1) return { rowWidth: ROW, trades: [{ ts: range.fromTs, columnMs: STEP, row: HIT_ROW, aggressor: "sell" as const, mode: "absorbed" as const, size: 5, count: 1 }], wallTrades: [], next: null, heldFrom: 0 };
        return { rowWidth: ROW, trades: [], wallTrades: [], next: { trades: { ts: range.fromTs }, wallTrades: null }, heldFrom: 0 };
      },
    };
    let chunks = 0;
    const done = backfillEventHistory(l2, engine, start - 10 * HISTORY_CHUNK_MS, 0, 1e9, () => { chunks += 1; }, () => true, { gapMs: 0, retryMs: 0 });
    expect(await done).toBe("short");
    expect(asked[0]).toMatchObject({ fromTs: start - HISTORY_CHUNK_MS, toTs: start, cursor: null });
    expect(chunks).toBe(1);
    expect(engine.coveredFrom).toBe(start - HISTORY_CHUNK_MS);
    expect(asked[1]).toMatchObject({ fromTs: start - 2 * HISTORY_CHUNK_MS, toTs: start - HISTORY_CHUNK_MS });
    expect(asked.filter((a) => a.cursor === null)).toHaveLength(1 + MAX_CHUNK_ATTEMPTS);
    expect(asked).toHaveLength(1 + MAX_CHUNK_ATTEMPTS * MAX_PAGES_PER_CHUNK);
  });

  it("stops where the runtime's own memory starts: an empty page from before it moves the coverage nowhere, so those columns stay unknown instead of reading as nothing traded (PR #39 review)", async () => {
    const printed = tape(Array.from({ length: 20 }, () => ({ wall: 150 })), 40);
    const feed = new L2Feed();
    feed.events([feed.sell(printed[17].ts + 5 * S, 60)], { ts: T + 40 * STEP });
    const engine = new EngineAbsorptionTracker(true);
    engine.columns(feed.l2, feedOf(printed), ROW);
    const start = engine.coveredFrom ?? 0;
    expect(start).toBe(printed[17].ts);
    const asked: number[] = [];
    const l2 = {
      ...feed.l2,
      eventHistory: async (range: { fromTs: number; toTs: number }) => {
        asked.push(range.toTs);
        return { rowWidth: ROW, trades: [], wallTrades: [], next: null, heldFrom: range.toTs };
      },
    };
    let chunks = 0;
    expect(await backfillEventHistory(l2, engine, start - 4 * HISTORY_CHUNK_MS, 0, 1e9, () => { chunks += 1; }, () => true, { gapMs: 0, retryMs: 0 })).toBe("held");
    expect(asked).toEqual([start]);
    expect(chunks).toBe(0);
    expect(engine.coveredFrom).toBe(start);
    const before = engine.columns(feed.l2, feedOf(printed), ROW).feed.fine.columns[2];
    expect(before.ts).toBeLessThan(start);
    expect(before.buy).toBeUndefined();
    expect(before.sell).toBeUndefined();
  });

  it("takes a chunk only from where the runtime holds it, the latest start its pages name: older trades are left out, the coverage stops there and nothing older is asked (PR #39 review)", async () => {
    const printed = tape(Array.from({ length: 20 }, () => ({ wall: 150 })), 40);
    const feed = new L2Feed();
    feed.events([feed.sell(printed[17].ts + 5 * S, 60)], { ts: T + 40 * STEP });
    const engine = new EngineAbsorptionTracker();
    run(engine, feed.l2, feedOf(printed), T + 39 * STEP + 1);
    const start = engine.coveredFrom ?? 0;
    const held = printed[15].ts;
    const sell = (ts: number, size: number) => ({ ts, columnMs: STEP, row: HIT_ROW, aggressor: "sell" as const, mode: "absorbed" as const, size, count: 1 });
    const asked: unknown[] = [];
    const l2 = {
      ...feed.l2,
      eventHistory: async (range: { fromTs: number; toTs: number }, cursor?: unknown) => {
        asked.push(cursor ?? null);
        if (cursor === undefined) return { rowWidth: ROW, trades: [sell(printed[14].ts, 7)], wallTrades: [], next: { trades: { ts: printed[14].ts }, wallTrades: null }, heldFrom: held };
        return { rowWidth: ROW, trades: [sell(printed[15].ts, 5)], wallTrades: [], next: null, heldFrom: range.fromTs };
      },
    };
    let chunks = 0;
    expect(await backfillEventHistory(l2, engine, start - 4 * HISTORY_CHUNK_MS, 0, 1e9, () => { chunks += 1; }, () => true, { gapMs: 0, retryMs: 0 })).toBe("held");
    expect(asked).toHaveLength(2);
    expect(chunks).toBe(1);
    expect(engine.coveredFrom).toBe(held);
    expect(engine.tradedInto("sell", HIT_ROW, HIT_ROW, printed[14].ts, start)).toBe(5);
  });

  it("finishes as soon as its last chunk lands, with no pause after it, so the next fill can start at once", async () => {
    const printed = tape(Array.from({ length: 20 }, () => ({ wall: 150 })), 40);
    const feed = new L2Feed();
    feed.events([feed.sell(printed[17].ts + 5 * S, 60)], { ts: T + 40 * STEP });
    const engine = new EngineAbsorptionTracker();
    run(engine, feed.l2, feedOf(printed), T + 39 * STEP + 1);
    const start = engine.coveredFrom ?? 0;
    const l2 = { ...feed.l2, eventHistory: async () => ({ rowWidth: ROW, trades: [], wallTrades: [], next: null, heldFrom: 0 }) };
    vi.useFakeTimers();
    try {
      let finished: string | null = null;
      void backfillEventHistory(l2, engine, start - HISTORY_CHUNK_MS, 0, 1e9, () => undefined, () => true, { gapMs: 1_000, retryMs: 1_000 }).then((done) => {
        finished = done;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(finished).toBe("filled");
      expect(engine.coveredFrom).toBe(start - HISTORY_CHUNK_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a chunk the runtime refuses (an incomplete answer), with a growing pause, and carries on once it is served", async () => {
    const printed = tape(Array.from({ length: 20 }, () => ({ wall: 150 })), 40);
    const feed = new L2Feed();
    feed.events([feed.sell(printed[17].ts + 5 * S, 60)], { ts: T + 40 * STEP });
    const engine = new EngineAbsorptionTracker();
    run(engine, feed.l2, feedOf(printed), T + 39 * STEP + 1);
    const start = engine.coveredFrom ?? 0;
    const asked: number[] = [];
    let refusals = 2;
    const l2 = {
      ...feed.l2,
      eventHistory: async (range: { fromTs: number }) => {
        asked.push(Date.now());
        if (refusals > 0) { refusals -= 1; return null; }
        return { rowWidth: ROW, trades: [{ ts: range.fromTs, columnMs: STEP, row: HIT_ROW, aggressor: "sell" as const, mode: "absorbed" as const, size: 1, count: 1 }], wallTrades: [], next: null, heldFrom: 0 };
      },
    };
    vi.useFakeTimers();
    try {
      const done = backfillEventHistory(l2, engine, start - 2 * HISTORY_CHUNK_MS, 0, 1e9, () => undefined, () => true, { gapMs: 100, retryMs: 1_000 });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await done).toBe("filled");
      expect(asked).toHaveLength(4);
      expect(asked[1] - asked[0]).toBe(1_000);
      expect(asked[2] - asked[1]).toBe(2_000);
      expect(asked[3] - asked[2]).toBe(100);
      expect(engine.coveredFrom).toBe(start - 2 * HISTORY_CHUNK_MS);
    } finally {
      vi.useRealTimers();
    }
  });
});
