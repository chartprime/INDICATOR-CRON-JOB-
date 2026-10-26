import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createIndicatorRuntime } from "../indicatorRuntime";
import { historicalL2, indicatorL2Of, segmentStartTs, type IndicatorL2 } from "../indicatorL2";
import type { IndicatorBarCtx, RuntimeIndicatorDef } from "../indicatorTypes";
import { resetDrawOwnerScopeForTests } from "../draw/creationScope";
import { resetDrawRegistryForTests, tablesForOwners } from "../draw/registry";
import type { TableData } from "../draw/table";
import { L2Store, type L2Frame } from "../../l2/l2Store";
import { l2FeedStatusIndicator, statusRows } from "../../indicators/l2-feed-status/l2FeedStatus";
import { book, walk } from "./fixtures/syntheticMarket";
import { parseServerFrame, type L2EventHistoryFrame } from "../../../types/frames";
import { eventHistoryOf } from "../../l2/history";

// Report 61 P4b: ctx.l2, the one accessor indicator authors read the engine
// through. Lane 0 is the liquidity grid the chart already holds; lanes 1..6,
// walls, events and the ladder come from the L2 store. The runtime replays an
// L2 indicator when the source changes and re-runs the forming bar when it
// advances, exactly as it does for ctx.liquidity.

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

const ID = { provider: "BINANCE", symbol: "BTC-USDT", marketKind: "PERPETUAL" } as const;
const SEGMENT = { id: "PERPETUAL:BTCUSDT:5000:LIVE", state: "LIVE" };

function parse(raw: Record<string, unknown>): L2Frame {
  const frame = parseServerFrame(raw);
  if (frame === null) throw new Error(`fixture rejected: ${JSON.stringify(raw)}`);
  return frame as L2Frame;
}

function liveStore(): L2Store {
  const store = new L2Store();
  store.apply(parse({ type: "l2_walls", ...ID, ts: 10_000, seq: 1, reset: true, row_width: 0.5, walls: [], removed: [], segment: SEGMENT }));
  store.apply(parse({ type: "l2_events", ...ID, ts: 10_000, seq: 0, reset: true, missed: 0, events: [] }));
  store.apply(parse({ type: "l2_ladder", ...ID, ts: 10_000, depth: 50, bids: [[100, 1]], asks: [[101, 1]], segment: SEGMENT }));
  store.apply(parse({
    type: "l2_view", ...ID, lane: 1, tier: "recent", ts: 10_000, seq: 1, reset: true, row_width: 100, column_ms: 2_000,
    columns: [{ ts: 10_000, lo: 0, hi: 2_000, bid: [[0, 1]], ask: [[2_000, 1]] }], segment: SEGMENT,
  }));
  return store;
}

describe("ctx.l2: the SDK accessor", () => {
  it("is absent until there is a store, and says so honestly in Historical Mode", () => {
    expect(indicatorL2Of(null, () => null)).toBeNull();
    const historical = historicalL2();
    expect(historical.availability).toBe("HISTORICAL_UNAVAILABLE");
    expect(historical.trusted()).toBe(false);
    expect(historical.walls()).toEqual([]);
    expect(historical.events()).toMatchObject({ events: [], complete: false });
    expect(historical.ladder()).toBeNull();
    expect(historical.view(0)).toBeNull();
  });

  it("serves lane 0 from the liquidity grid and the wider lanes from the store", () => {
    const grid = book(walk(120));
    const l2 = indicatorL2Of(liveStore(), () => grid)!;
    expect(l2.view(0)?.fine.columns).toBe(grid.columns);
    expect(l2.view(1)?.fine.columns).toHaveLength(1);
    expect(l2.lanes().map((lane) => lane.lane)).toEqual([0, 1]);
    expect(l2.view(3)).toBeNull();
  });

  it("hands lane columns out read-only: the chart's own arrays, which the SDK types refuse to write", () => {
    const grid = book(walk(120));
    const l2 = indicatorL2Of(liveStore(), () => grid)!;
    const feed = l2.view(0)!;
    const column = feed.fine.columns[0];
    expect(column.bid).toBe(grid.columns[0].bid);
    const attempts = [
      // @ts-expect-error a cell is read-only through ctx.l2
      () => { column.bid[0] = 1; },
      // @ts-expect-error a column's geometry is read-only through ctx.l2
      () => { column.lo = 0; },
      // @ts-expect-error the column list is read-only through ctx.l2
      () => feed.fine.columns.push(column),
    ];
    expect(attempts).toHaveLength(3);
  });

  it("laneFor picks the finest lane that covers the range, lane 0 included, and the widest when none does", () => {
    const grid = book(walk(120));
    const l2 = indicatorL2Of(liveStore(), () => grid)!;
    const [zero, one] = l2.lanes();
    const inside = (zero.priceLo + zero.priceHi) / 2;
    expect(one.priceLo).toBeLessThan(zero.priceLo);
    expect(one.priceHi).toBeGreaterThan(zero.priceHi);
    expect(l2.laneFor(inside, inside)).toBe(0);
    expect(l2.laneFor(zero.priceLo, zero.priceHi)).toBe(0);
    expect(l2.laneFor(zero.priceLo - 1, zero.priceHi)).toBe(1);
    expect(l2.laneFor(one.priceLo - 1_000_000, one.priceHi + 1_000_000)).toBe(1);
    expect(l2.laneFor(zero.priceHi, zero.priceLo)).toBe(0);
  });

  it("trusted(ts) holds only from the current LIVE segment's start, and only while the channels read are synced", () => {
    const store = liveStore();
    const l2 = indicatorL2Of(store, () => null)!;
    expect(segmentStartTs({ id: "FUTURE:/NQZ26:XCME:1789:GAP", state: "GAP" })).toBe(1789);
    expect(l2.trusted()).toBe(true);
    expect(l2.trusted(5_000)).toBe(true);
    expect(l2.trusted(4_999)).toBe(false);
    store.markUntrusted();
    expect(l2.trusted()).toBe(false);
  });

  it("reads through to the store: its version, events and ladder move with it", () => {
    const store = liveStore();
    const l2 = indicatorL2Of(store, () => null)!;
    const before = l2.version;
    store.apply(parse({ type: "l2_events", ...ID, ts: 11_000, seq: 1, reset: false, missed: 0, events: [{ event: "hidden", ts: 10_500, side: "bid", price: 100, volume: 1 }] }));
    expect(l2.version).toBeGreaterThan(before);
    expect(l2.events(0)).toMatchObject({ seq: 1, complete: true });
    expect(l2.events(0).events).toHaveLength(1);
    expect(l2.ladder()?.bids).toEqual([[100, 1]]);
  });
});

describe("the runtime hands ctx.l2 to L2 indicators", () => {
  function recorder(category: "l2" | "technical") {
    const seen: { l2: IndicatorL2 | undefined; replaying: boolean; drawNow: boolean | undefined }[] = [];
    const def: RuntimeIndicatorDef<{ n: number }, Record<string, never>> = {
      kind: "runtime", id: `probe-${category}`, label: "probe", category, defaultSettings: {}, lines: [], placement: { kind: "overlay" },
      readOutput: () => ({}),
      createState: () => ({ n: 0 }),
      onBar: (ctx: IndicatorBarCtx<{ n: number }, Record<string, never>>) => {
        seen.push({ l2: ctx.l2, replaying: ctx.replaying, drawNow: ctx.drawNow });
      },
    };
    return { def: def as unknown as RuntimeIndicatorDef<unknown, unknown>, seen };
  }

  it("cuts historical SDK input separately at each bar close during a snapshot replay", () => {
    const bars = walk(3);
    const probe = recorder("l2");
    const cuts: number[] = [];
    const source: IndicatorL2 = { ...historicalL2(), availability: "HISTORICAL", atTime: (time) => {
      cuts.push(time); return { ...historicalL2(), version: time };
    } };
    const runtime = createIndicatorRuntime([probe.def]);
    runtime.setL2(source);
    runtime.setActiveAndReplay(new Set([probe.def.id]), {}, bars);
    expect(cuts).toEqual(bars.map((bar) => bar.ts_open + bar.interval_ms));
    expect(probe.seen.map((call) => call.l2?.version)).toEqual(cuts);
    expect(probe.seen.every((call) => call.l2 !== source)).toBe(true);
  });

  it("replays an L2 indicator when the source changes, never when the same source is set again, and never a non-L2 one", () => {
    const bars = walk(30);
    const l2probe = recorder("l2");
    const other = recorder("technical");
    const runtime = createIndicatorRuntime([l2probe.def, other.def]);
    runtime.setActiveAndReplay(new Set([l2probe.def.id, other.def.id]), {}, bars);
    const l2 = indicatorL2Of(liveStore(), () => null);
    l2probe.seen.length = 0;
    other.seen.length = 0;
    runtime.setL2(l2, bars);
    expect(l2probe.seen).toHaveLength(bars.length);
    expect(l2probe.seen.every((call) => call.l2 === l2)).toBe(true);
    expect(other.seen).toHaveLength(0);
    runtime.setL2(l2, bars);
    expect(l2probe.seen).toHaveLength(bars.length);
  });

  it("an indicator activated after the source was set sees it from its first bar", () => {
    const bars = walk(10);
    const l2probe = recorder("l2");
    const runtime = createIndicatorRuntime([l2probe.def]);
    const l2 = indicatorL2Of(liveStore(), () => null);
    runtime.setL2(l2);
    runtime.setActiveAndReplay(new Set([l2probe.def.id]), {}, bars);
    expect(l2probe.seen.every((call) => call.l2 === l2)).toBe(true);
  });

  it("re-runs only the forming bar of an L2 indicator when the feed advances", () => {
    const bars = walk(30);
    const l2probe = recorder("l2");
    const other = recorder("technical");
    const runtime = createIndicatorRuntime([l2probe.def, other.def]);
    runtime.setActiveAndReplay(new Set([l2probe.def.id, other.def.id]), {}, bars);
    runtime.setL2(indicatorL2Of(liveStore(), () => null), bars);
    l2probe.seen.length = 0;
    other.seen.length = 0;
    runtime.onL2Advanced(bars);
    expect(l2probe.seen).toEqual([expect.objectContaining({ replaying: false, drawNow: true })]);
    expect(other.seen).toHaveLength(0);
    runtime.onL2Advanced(bars.slice(0, -1));
    expect(l2probe.seen).toHaveLength(1);
  });
});

describe("L2 feed status indicator", () => {
  it("says plainly when there is no feed, and when the chart is historical", () => {
    expect(statusRows(undefined, 0)).toEqual([{ label: "L2 feed", value: "not connected", tone: "bad" }]);
    expect(statusRows(historicalL2(), 0)).toEqual([{ label: "L2 feed", value: "unavailable in Historical Mode", tone: "neutral" }]);
  });

  it("reports trust, the segment, every channel's sync and lag, and what is held", () => {
    const store = new L2Store({ now: () => 1_000 });
    for (const frame of [
      parse({ type: "l2_walls", ...ID, ts: 10_000, seq: 1, reset: true, row_width: 0.5, removed: [], segment: SEGMENT, walls: [
        { id: 1, side: "bid", row: 200, span: 1, start_ts: 1_000, end_ts: null, size: 12, peak: 12, ended_by: null, ratio: 4, chain: 0, fill: 0, eaten: 0, absorbing: false, detail: null },
        { id: 2, side: "ask", row: 210, span: 1, start_ts: 1_000, end_ts: 9_000, size: 1, peak: 12, ended_by: "pulled", ratio: 4, chain: 0, fill: 0, eaten: 0, absorbing: false, detail: null },
      ] }),
      parse({ type: "l2_events", ...ID, ts: 10_000, seq: 1, reset: true, missed: 0, events: [{ event: "hidden", ts: 9_000, side: "bid", price: 100, volume: 1 }] }),
      parse({ type: "l2_events", ...ID, ts: 10_500, seq: 1, reset: false, missed: 4, events: [] }),
      parse({ type: "l2_ladder", ...ID, ts: 10_000, depth: 50, bids: [[100, 1]], asks: [[101, 1]], segment: SEGMENT }),
    ]) store.apply(frame);
    const rows = statusRows(indicatorL2Of(store, () => null)!, 3_500);
    const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));
    expect(byLabel["Walls/events trusted"]).toEqual({ label: "Walls/events trusted", value: "yes", tone: "good" });
    expect(byLabel.Segment.value).toBe("LIVE PERPETUAL:BTCUSDT:5000:LIVE");
    expect(byLabel.Walls).toMatchObject({ value: "synced seq 1, 2.5 s ago", tone: "good" });
    expect(byLabel.Lanes).toMatchObject({ value: "untrusted, no frame yet", tone: "bad" });
    expect(byLabel["Lane coverage"]).toMatchObject({ value: "none yet", tone: "neutral" });
    expect(new Set(rows.map((row) => row.label)).size).toBe(rows.length);
    expect(byLabel["Walls held"].value).toBe("1 active, 1 ended");
    expect(byLabel["Events held"]).toMatchObject({ value: "1, 4 missed by the cap", tone: "bad" });
    expect(byLabel["Book held"].value).toBe("1x1 of 50, best 100 / 101");
    expect(byLabel.Ladder).toMatchObject({ tone: "good" });
    expect(byLabel.Segment.tone).toBe("good");

    store.markUntrusted();
    const dropped = Object.fromEntries(statusRows(indicatorL2Of(store, () => null)!, 3_500).map((row) => [row.label, row]));
    expect(dropped["Walls/events trusted"].tone).toBe("bad");
    expect(dropped.Segment).toMatchObject({ value: "LIVE PERPETUAL:BTCUSDT:5000:LIVE", tone: "neutral" });
  });

  it("draws its rows as a table when the feed advances", () => {
    const bars = walk(20);
    const runtime = createIndicatorRuntime([l2FeedStatusIndicator as unknown as RuntimeIndicatorDef<unknown, unknown>]);
    runtime.setActiveAndReplay(new Set(["l2FeedStatus"]), {}, bars);
    runtime.setL2(indicatorL2Of(liveStore(), () => null), bars);
    runtime.onL2Advanced(bars);
    const [table] = tablesForOwners([runtime.getDrawOwnerId("l2FeedStatus")!]);
    const grid = (table.data as TableData).committedGrid;
    expect(grid["0,0"].text).toBe("Walls/events trusted");
    expect(grid["0,1"].text).toBe("yes");
    expect(Object.keys(grid)).toHaveLength(20);
  });

  it("draws historical status on the final replay bar using chart time, not the wall clock", () => {
    const bars = walk(20);
    const cuts: number[] = [];
    const source: IndicatorL2 = { ...historicalL2(), availability: "HISTORICAL",
      trusted: (ts) => { if (ts !== undefined) cuts.push(ts); return true; },
      atTime: () => source,
    };
    const runtime = createIndicatorRuntime([l2FeedStatusIndicator as unknown as RuntimeIndicatorDef<unknown, unknown>]);
    runtime.setL2(source, bars);
    runtime.setActiveAndReplay(new Set(["l2FeedStatus"]), {}, bars);
    const owner = runtime.getDrawOwnerId("l2FeedStatus")!;
    const grid = (tablesForOwners([owner])[0].data as TableData).committedGrid;
    expect(grid["0,1"].text).toBe("verified historical book states");
    expect(grid["1,1"].text).toBe("yes");
    expect(cuts).toEqual([bars.at(-1)!.ts_open + bars.at(-1)!.interval_ms]);
  });

  it("replaces the live status table when switching to Historical Mode", () => {
    const bars = walk(20);
    const runtime = createIndicatorRuntime([l2FeedStatusIndicator as unknown as RuntimeIndicatorDef<unknown, unknown>]);
    runtime.setActiveAndReplay(new Set(["l2FeedStatus"]), {}, bars);
    runtime.setL2(indicatorL2Of(liveStore(), () => null), bars);
    runtime.onL2Advanced(bars);
    const owner = runtime.getDrawOwnerId("l2FeedStatus")!;
    expect(Object.keys((tablesForOwners([owner])[0].data as TableData).committedGrid)).toHaveLength(20);
    runtime.setL2(historicalL2(), bars);
    runtime.onL2Advanced(bars);
    const historicalGrid = (tablesForOwners([owner])[0].data as TableData).committedGrid;
    expect(Object.keys(historicalGrid).sort()).toEqual(["0,0", "0,1"]);
    expect(historicalGrid["0,1"].text).toBe("unavailable in Historical Mode");
  });

  it("an l2_event_history frame says from where the runtime holds the trades: the runtime's own frame parses, and a complete one without it, or with it outside the asked range, is refused (PR #39 review)", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const require = createRequire(import.meta.url);
    const { eventHistoryFrame } = require(path.join(here, "../../../../../runtime/src/server/history-frames.js"));
    const T = 1_780_000_000_000;
    const identity = { provider: "BINANCE", symbol: "BTCUSDT", marketKind: "PERPETUAL" };
    const request = { requestId: 4, fromTs: T - 60_000, toTs: T, priceLo: 100, priceHi: 200 };
    const built = JSON.parse(JSON.stringify(eventHistoryFrame(identity, { request, rowWidth: 0.5, complete: true, tradesHeldFrom: T - 30_000 }))) as Record<string, unknown>;
    const parsed = parseServerFrame(built);
    expect(parsed).toMatchObject({ type: "l2_event_history", complete: true, trades_held_from: T - 30_000 });
    expect(eventHistoryOf(parsed as L2EventHistoryFrame)?.heldFrom).toBe(T - 30_000);
    const without = { ...built };
    delete without.trades_held_from;
    expect(parseServerFrame(without)).toBeNull();
    for (const bad of [null, T - 60_001, T + 1, 1.5, "x"]) expect(parseServerFrame({ ...built, trades_held_from: bad })).toBeNull();
    expect(parseServerFrame({ ...built, trades_held_from: T - 60_000 })).not.toBeNull();
    expect(parseServerFrame({ ...built, trades_held_from: T })).not.toBeNull();
    const refused = JSON.parse(JSON.stringify(eventHistoryFrame(identity, { request, rowWidth: 0.5, complete: false, reason: "OVERLOADED", retryAfterMs: 500 }))) as Record<string, unknown>;
    expect(parseServerFrame(refused)).toMatchObject({ complete: false, trades_held_from: null });
    expect(parseServerFrame({ ...refused, trades_held_from: T })).toBeNull();
  });

  it("wallHistory and eventHistory go through the requester and come back typed, with history ids kept apart from live ids; without a requester or in Historical Mode they answer null", async () => {
    const asked: unknown[] = [];
    const wall = { hid: 3, side: "bid", row: 200, span: 2, start_ts: 1_000, end_ts: 9_000, size: 0, peak: 30, ended_by: "filled", ratio: 4, chain: 0, fill: 0.5, eaten: 0.5, detail: { traded: 15, absorbed: 15, swept: 0, hidden: 0, cleared: 30, cross_side: 1, fill_ratio: 0.5, first_shrink_ts: 2_000, reached_at_first_shrink: true, end_distance_rows: 0, cleared_by_trades: true, repeats: 2, evidence_gap: false } };
    const requester = async (kind: string, request: unknown) => {
      asked.push([kind, request]);
      const head = { ...ID, request_id: 1, from_ts: 1_000, to_ts: 10_000, price_lo: 100, price_hi: 200, row_width: 0.5, complete: true, reason: null, retry_after_ms: null };
      if (kind === "wall_history") return parseServerFrame({ type: "wall_history", ...head, walls: [wall], next: { end_ts: 9_000, hid: 3 } }) as never;
      return parseServerFrame({ type: "l2_event_history", ...head, trades: [[2_000, 1_000, 200, "sell", "absorbed", 2.5, 2]], wall_trades: [[2_000, "bid:200:2:1000", "absorbed", 2.5, 2]], trades_held_from: 4_000, next: null }) as never;
    };
    const l2 = indicatorL2Of(liveStore(), () => null, requester)!;
    const range = { fromTs: 1_000, toTs: 10_000, priceLo: 100, priceHi: 200 };
    const walls = await l2.wallHistory(range);
    expect(walls).toEqual({ rowWidth: 0.5, next: { endTs: 9_000, hid: 3 }, walls: [expect.objectContaining({ id: -3, side: "bid", row: 200, span: 2, startTs: 1_000, endTs: 9_000, peak: 30, endedBy: "filled", absorbing: false, detail: expect.objectContaining({ traded: 15, repeats: 2, evidenceGap: false, lifeMs: null }) })] });
    const events = await l2.eventHistory(range, { trades: { ts: 2_000, row: 200, aggressor: "sell", mode: "absorbed" }, wall_trades: null });
    expect(events).toEqual({ rowWidth: 0.5, next: null, heldFrom: 4_000, trades: [{ ts: 2_000, columnMs: 1_000, row: 200, aggressor: "sell", mode: "absorbed", size: 2.5, count: 2 }], wallTrades: [{ ts: 2_000, wall: "bid:200:2:1000", mode: "absorbed", size: 2.5, count: 2 }] });
    expect(asked).toEqual([
      ["wall_history", { from_ts: 1_000, to_ts: 10_000, price_lo: 100, price_hi: 200 }],
      ["l2_event_history", { from_ts: 1_000, to_ts: 10_000, price_lo: 100, price_hi: 200, cursor: { trades: { ts: 2_000, row: 200, aggressor: "sell", mode: "absorbed" }, wall_trades: null } }],
    ]);
    const refused = indicatorL2Of(liveStore(), () => null, async () => parseServerFrame({ type: "wall_history", ...ID, request_id: 1, from_ts: 1_000, to_ts: 10_000, price_lo: 100, price_hi: 200, row_width: 0.5, complete: false, reason: "OVERLOADED", retry_after_ms: 1_000, walls: [], next: null }) as never)!;
    expect(await refused.wallHistory(range)).toBeNull();
    expect(await indicatorL2Of(liveStore(), () => null)!.wallHistory(range)).toBeNull();
    expect(await historicalL2().eventHistory(range)).toBeNull();
  });

  it("serves walls by lane: walls() is lane 0, walls(k) the wider lane, and wall(id) finds either", () => {
    const store = liveStore();
    const base = { side: "bid", row: 200, span: 1, start_ts: 1_000, end_ts: null, size: 12, peak: 12, ended_by: null, ratio: 4, chain: 0, fill: 0, eaten: 0, absorbing: false, detail: null };
    store.apply(parse({ type: "l2_walls", ...ID, ts: 10_000, seq: 2, reset: false, row_width: 0.5, removed: [], segment: SEGMENT, walls: [{ id: 1, lane: 0, ...base }, { id: 10_000_001, lane: 1, ...base, row: 100 }] }));
    const l2 = indicatorL2Of(store, () => null)!;
    expect(l2.walls().map((wall) => [wall.id, wall.lane])).toEqual([[1, 0]]);
    expect(l2.walls(1).map((wall) => [wall.id, wall.lane, wall.row])).toEqual([[10_000_001, 1, 100]]);
    expect(l2.walls(2)).toEqual([]);
    expect(l2.wall(10_000_001)?.lane).toBe(1);
    expect(l2.wall(1)?.lane).toBe(0);
  });
});
