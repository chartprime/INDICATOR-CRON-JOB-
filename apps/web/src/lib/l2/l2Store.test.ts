import { describe, expect, it } from "vitest";
import { parseServerFrame, type L2Channel } from "../../types/frames";
import { EventRing } from "./eventRing";
import { L2Store, L2_RESYNC_DEBOUNCE_MS, type L2Frame } from "./l2Store";
import { DEFAULT_LIQUIDITY_CAPACITY, DEFAULT_LIQUIDITY_DEEP_CAPACITY } from "../indicators/passive-liquidity/liquidityGrid";

// Report 61 P4b. The client models apply the P4a recovery rules: a reset
// replaces, the next increment must continue the chain, anything at or below
// the chain is a duplicate (the increment a snapshot already contains), and
// anything else is a gap that makes the channel untrusted and asks the server
// for that one channel again.

const ID = { provider: "BINANCE", symbol: "BTC-USDT", marketKind: "PERPETUAL" } as const;
const SEGMENT = { id: "PERPETUAL:BTCUSDT:1000:LIVE", state: "LIVE" };

function parse(raw: Record<string, unknown>): L2Frame {
  const frame = parseServerFrame(raw);
  if (frame === null || !frame.type.startsWith("l2_")) throw new Error(`fixture rejected: ${JSON.stringify(raw)}`);
  return frame as L2Frame;
}

function wall(id: number, size = 12): Record<string, unknown> {
  return { id, side: "bid", row: 200, span: 1, start_ts: 1_000, end_ts: null, size, peak: Math.max(size, 12), ended_by: null, ratio: 4, chain: 0, fill: 0, eaten: 0, absorbing: false, detail: null };
}

const walls = (seq: number, reset: boolean, list: Record<string, unknown>[], removed: number[] = [], segment: Record<string, unknown> | null = SEGMENT) =>
  parse({ type: "l2_walls", ...ID, ts: 10_000 + seq, seq, reset, row_width: 0.5, walls: list, removed, segment });

const hidden = (ts: number) => ({ event: "hidden", ts, side: "bid", price: 100, volume: 1 });
const events = (seq: number, reset: boolean, list: Record<string, unknown>[], missed = 0) =>
  parse({ type: "l2_events", ...ID, ts: 20_000, seq, reset, missed, events: list });

const column = (ts: number, bid: number) => ({ ts, lo: 100, hi: 103, bid: [[0, bid]], ask: [[3, 1]] });
const view = (seq: number, reset: boolean, ts: number, lane = 1, tier = "recent", columnMs = 2_000, segment: Record<string, unknown> | null = SEGMENT) =>
  parse({ type: "l2_view", ...ID, lane, tier, ts, seq, reset, row_width: 8, column_ms: columnMs, columns: [column(ts, seq)], segment });

const ladder = (ts: number, segment: Record<string, unknown> | null = SEGMENT) =>
  parse({ type: "l2_ladder", ...ID, ts, depth: 50, bids: [[100, 1]], asks: [[101, 2]], segment });

function store() {
  const clock = { now: 0 };
  const resyncs: L2Channel[] = [];
  const s = new L2Store({ now: () => clock.now, requestResync: (channel) => resyncs.push(channel) });
  return { s, clock, resyncs };
}

describe("L2Store: walls", () => {
  it("a reset replaces, increments upsert and remove in order, and the list is frozen", () => {
    const { s } = store();
    expect(s.apply(walls(1, true, [wall(1), wall(2)]))).toBe(true);
    expect(s.apply(walls(2, false, [wall(1, 20), wall(3)], [2]))).toBe(true);
    expect(s.walls.list().map((w) => [w.id, w.size])).toEqual([[1, 20], [3, 12]]);
    expect(Object.isFrozen(s.walls.list())).toBe(true);
    expect(Object.isFrozen(s.walls.get(1))).toBe(true);
    expect(s.status("l2_walls")).toMatchObject({ synced: true, seq: 2 });
  });

  it("an increment the snapshot already contains is dropped without asking again", () => {
    const { s, resyncs } = store();
    s.apply(walls(5, true, [wall(1, 30)]));
    expect(s.apply(walls(5, false, [wall(1, 99)]))).toBe(false);
    expect(s.apply(walls(4, false, [wall(1, 98)]))).toBe(false);
    expect(s.walls.get(1)?.size).toBe(30);
    expect(resyncs).toEqual([]);
    expect(s.status("l2_walls").synced).toBe(true);
  });

  it("a gap makes the channel untrusted, asks once per debounce window, and a reset restores it", () => {
    const { s, clock, resyncs } = store();
    s.apply(walls(1, true, [wall(1)]));
    expect(s.apply(walls(3, false, [wall(2)]))).toBe(false);
    expect(s.apply(walls(4, false, [wall(2)]))).toBe(false);
    expect(resyncs).toEqual(["l2_walls"]);
    expect(s.status("l2_walls").synced).toBe(false);
    clock.now += L2_RESYNC_DEBOUNCE_MS;
    s.apply(walls(5, false, [wall(2)]));
    expect(resyncs).toEqual(["l2_walls", "l2_walls"]);
    expect(s.apply(walls(9, true, [wall(7)]))).toBe(true);
    expect(s.status("l2_walls")).toMatchObject({ synced: true, seq: 9 });
    expect(s.walls.list().map((w) => w.id)).toEqual([7]);
  });

  it("an increment before any reset is a gap, not a partial picture", () => {
    const { s, resyncs } = store();
    expect(s.apply(walls(3, false, [wall(1)]))).toBe(false);
    expect(s.walls.list()).toEqual([]);
    expect(resyncs).toEqual(["l2_walls"]);
  });
});

describe("L2Store: events", () => {
  it("a reset replaces, increments continue the chain, missed accumulates", () => {
    const { s } = store();
    s.apply(events(2, true, [hidden(1_000), hidden(1_100)]));
    s.apply(events(4, false, [hidden(1_200), hidden(1_300)], 5));
    s.apply(events(4, false, [], 2));
    const all = s.events.since();
    expect(all.events.map((e) => e.ts)).toEqual([1_000, 1_100, 1_200, 1_300]);
    expect(all.missed).toBe(7);
    expect(Object.isFrozen(all.events)).toBe(true);
    expect(all.events.every((e) => e.kind === "hidden")).toBe(true);
  });

  it("since(seq) is exact after the reset and says so; before it, it returns the ring marked incomplete", () => {
    const { s } = store();
    s.apply(events(2, true, [hidden(1_000), hidden(1_100)]));
    s.apply(events(3, false, [hidden(1_200)]));
    s.apply(events(5, false, [hidden(1_300), hidden(1_400)]));
    expect(s.events.since(3)).toMatchObject({ seq: 5, complete: true });
    expect(s.events.since(3).events.map((e) => e.ts)).toEqual([1_300, 1_400]);
    expect(s.events.since(5).events).toEqual([]);
    expect(s.events.since(1)).toMatchObject({ complete: false });
    expect(s.events.since(1).events).toHaveLength(5);
  });

  it("never calls a slice complete after the publisher reports omitted events", () => {
    const { s } = store();
    s.apply(events(1, true, [hidden(1_000)]));
    s.apply(events(2, false, [hidden(1_100)], 3));
    expect(s.events.since(1)).toMatchObject({ seq: 2, missed: 3, complete: false });
    expect(s.events.since(1).events.map((e) => e.ts)).toEqual([1_100]);
    s.apply(events(3, false, [hidden(1_200)]));
    expect(s.events.since(2)).toMatchObject({ seq: 3, complete: false });
    expect(s.events.since(3)).toMatchObject({ seq: 3, missed: 3, complete: true });
    s.apply(events(3, true, [hidden(1_200)]));
    expect(s.events.since(3)).toMatchObject({ missed: 0, complete: true });
  });

  it("a duplicate is dropped and a gap is untrusted until the next reset", () => {
    const { s, resyncs } = store();
    s.apply(events(2, true, [hidden(1_000), hidden(1_100)]));
    expect(s.apply(events(2, false, [hidden(1_100)]))).toBe(false);
    expect(s.apply(events(6, false, [hidden(1_500)]))).toBe(false);
    expect(resyncs).toEqual(["l2_events"]);
    expect(s.events.since(2).complete).toBe(false);
    s.apply(events(6, true, [hidden(1_500)]));
    expect(s.status("l2_events").synced).toBe(true);
  });

  it("the client ring keeps the newest events up to its capacity", () => {
    const ring = new EventRing(3);
    ring.apply(events(2, true, [hidden(1_000), hidden(1_100)]) as Parameters<EventRing["apply"]>[0]);
    ring.apply(events(4, false, [hidden(1_200), hidden(1_300)]) as Parameters<EventRing["apply"]>[0]);
    expect(ring.since().events.map((e) => e.ts)).toEqual([1_100, 1_200, 1_300]);
    expect(ring.since(1).complete).toBe(false);
    expect(ring.since(2).events.map((e) => e.ts)).toEqual([1_200, 1_300]);
  });
});

describe("L2Store: lanes", () => {
  it("each lane chains per tier; the increment a snapshot already holds is dropped, not a gap", () => {
    const { s, resyncs } = store();
    s.apply(view(3, true, 4_000));
    expect(s.apply(view(3, false, 4_000))).toBe(false);
    expect(s.apply(view(4, false, 6_000))).toBe(true);
    expect(resyncs).toEqual([]);
    expect(s.lanes.laneSynced(1)).toBe(true);
    expect(s.lanes.view(1)?.fine.columns.map((c) => c.ts)).toEqual([4_000, 6_000]);
  });

  it("a gap in a lane is untrusted until that lane resets, and asks for the view channel", () => {
    const { s, resyncs } = store();
    s.apply(view(3, true, 4_000));
    expect(s.apply(view(6, false, 10_000))).toBe(false);
    expect(s.lanes.laneSynced(1)).toBe(false);
    expect(resyncs).toEqual(["l2_view"]);
    s.apply(view(7, true, 12_000));
    expect(s.lanes.laneSynced(1)).toBe(true);
  });

  it("a recent-tier reset cannot hide a gap in the same lane's deep tier", () => {
    const { s } = store();
    s.apply(view(1, true, 4_000, 1, "deep", 20_000));
    s.apply(view(1, true, 4_000, 1, "recent", 2_000));
    expect(s.lanes.laneSynced(1)).toBe(true);
    expect(s.apply(view(3, false, 44_000, 1, "deep", 20_000))).toBe(false);
    expect(s.lanes.laneSynced(1)).toBe(false);
    s.apply(view(2, true, 6_000, 1, "recent", 2_000));
    expect(s.lanes.laneSynced(1)).toBe(false);
    s.apply(view(3, true, 44_000, 1, "deep", 20_000));
    expect(s.lanes.laneSynced(1)).toBe(true);
  });

  it("a stale frame on a broken deep tier still asks for a resync after the recent tier reset, never passing as a duplicate", () => {
    const { s, clock, resyncs } = store();
    s.apply(view(1, true, 4_000, 1, "deep", 20_000));
    s.apply(view(1, true, 4_000, 1, "recent", 2_000));
    expect(s.apply(view(3, false, 44_000, 1, "deep", 20_000))).toBe(false);
    expect(resyncs).toEqual(["l2_view"]);
    s.apply(view(2, true, 6_000, 1, "recent", 2_000));
    clock.now += 5_000;
    expect(s.apply(view(1, false, 24_000, 1, "deep", 20_000))).toBe(false);
    expect(resyncs).toEqual(["l2_view", "l2_view"]);
    expect(s.lanes.laneSynced(1)).toBe(false);
  });

  it("a lane holds the span lane 0 holds: its capacity is lane 0's divided by the lane's factor, on both tiers, so a zoom never shows a shorter past", () => {
    const { s } = store();
    // Frames carry at most 120 columns and a seq that counts them, so the tier is filled by a reset and a chain of increments.
    const T0 = 1_700_000_000_000;
    const many = (seq: number, reset: boolean, from: number, tier: string, columnMs: number) =>
      parse({ type: "l2_view", ...ID, lane: 1, tier, ts: from + 119 * columnMs, seq, reset, row_width: 8, column_ms: columnMs, columns: Array.from({ length: 120 }, (_, i) => column(from + i * columnMs, 1)), segment: SEGMENT });
    const fill = (tier: string, columnMs: number, frames: number) => { for (let i = 0; i < frames; i += 1) expect(s.apply(many((i + 1) * 120, i === 0, T0 + i * 120 * columnMs, tier, columnMs))).toBe(true); };
    // The recent tier names the lane's fine columns; the deep tier follows, as on the wire.
    fill("recent", 2_000, 6);
    expect(s.lanes.grid(1)?.columns).toHaveLength(720);
    expect(DEFAULT_LIQUIDITY_CAPACITY / 2).toBe(3_600);
    fill("deep", 20_000, 4);
    expect(s.lanes.grid(1)?.deepColumns).toHaveLength(480);
    fill("deep", 20_000, 18);
    expect(DEFAULT_LIQUIDITY_DEEP_CAPACITY / 2).toBe(2_000);
    expect(s.lanes.grid(1)?.deepColumns).toHaveLength(2_000);
    expect(s.lanes.grid(1)?.deepColumns[0].ts).toBe(T0 + 160 * 20_000);
  });

  it("on an index market a lane's columns carry lane 0's yardstick at their time and tier; a crypto lane keeps the one measured on its own rows", () => {
    const asked: [number, boolean][] = [];
    const yardstick = (ts: number, deep: boolean) => {
      asked.push([ts, deep]);
      return ts === 1_700_000_004_000 ? null : { reference: deep ? 70 : 7, median: deep ? 30 : 3, ceiling: deep ? 900 : 90 };
    };
    const DX = { provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" } as const;
    const dxView = (seq: number, ts: number, tier: string, columnMs: number) =>
      parse({ type: "l2_view", ...DX, lane: 1, tier, ts, seq, reset: seq === 1, row_width: 0.5, column_ms: columnMs, columns: [column(ts, 5)], segment: SEGMENT });
    const s = new L2Store({ yardstick });
    expect(s.apply(dxView(1, 1_700_000_000_000, "recent", 2_000))).toBe(true);
    expect(s.apply(dxView(1, 1_700_000_000_000, "deep", 20_000))).toBe(true);
    expect(s.lanes.grid(1)?.columns[0]).toMatchObject({ reference: 7, median: 3, ceiling: 90 });
    expect(s.lanes.grid(1)?.deepColumns[0]).toMatchObject({ reference: 70, median: 30, ceiling: 900 });
    expect(asked).toEqual([[1_700_000_000_000, false], [1_700_000_000_000, true]]);
    // No yardstick at that time: the column keeps exactly what it would carry without one.
    expect(s.apply(dxView(2, 1_700_000_004_000, "recent", 2_000))).toBe(true);
    const plain = new L2Store();
    for (const frame of [dxView(1, 1_700_000_000_000, "recent", 2_000), dxView(2, 1_700_000_004_000, "recent", 2_000)]) expect(plain.apply(frame)).toBe(true);
    expect(s.lanes.grid(1)?.columns[1].reference).toBe(plain.lanes.grid(1)?.columns[1].reference);
    expect(s.lanes.grid(1)?.columns[1].median).toBe(plain.lanes.grid(1)?.columns[1].median);
    expect(s.lanes.grid(1)?.columns[1].ceiling).toBe(plain.lanes.grid(1)?.columns[1].ceiling);
    const crypto = new L2Store({ yardstick });
    asked.length = 0;
    expect(crypto.apply(view(1, true, 1_700_000_000_000))).toBe(true);
    expect(asked).toEqual([]);
    expect(crypto.lanes.grid(1)?.columns[0].reference).not.toBe(7);
  });

  it("lanes() reports each lane's geometry and price coverage", () => {
    const { s } = store();
    s.apply(view(3, true, 4_000, 2, "recent", 4_000));
    s.apply(view(1, true, 3_000, 1));
    expect(s.lanes.lanes()).toEqual([
      { lane: 1, rowWidth: 8, columnMs: 2_000, deepColumnMs: 0, priceLo: 800, priceHi: 832 },
      { lane: 2, rowWidth: 8, columnMs: 4_000, deepColumnMs: 0, priceLo: 800, priceHi: 832 },
    ]);
  });
});

describe("L2Store: ladder, segment, trust and lifecycle", () => {
  it("the ladder is latest state and carries the segment", () => {
    const { s } = store();
    s.apply(ladder(1_000));
    s.apply(ladder(2_000, { id: "PERPETUAL:BTCUSDT:1500:GAP", state: "GAP" }));
    expect(s.ladder.ladder?.ts).toBe(2_000);
    expect(s.segment).toEqual({ id: "PERPETUAL:BTCUSDT:1500:GAP", state: "GAP" });
    expect(Object.isFrozen(s.ladder.ladder?.bids)).toBe(true);
  });

  it("a delayed channel snapshot cannot rewind the current segment", () => {
    const { s } = store();
    s.apply(ladder(2_000, { id: "PERPETUAL:BTCUSDT:1500:GAP", state: "GAP" }));
    s.apply(view(1, true, 4_000));
    expect(s.segment).toEqual({ id: "PERPETUAL:BTCUSDT:1500:GAP", state: "GAP" });
    s.apply(events(1, true, [{ event: "segment", ts: 1_000, segment: "PERPETUAL:BTCUSDT:1000:LIVE", state: "LIVE", cause: null }]));
    expect(s.segment).toEqual({ id: "PERPETUAL:BTCUSDT:1500:GAP", state: "GAP" });
    s.apply(view(2, true, 6_000, 1, "recent", 2_000, { id: "PERPETUAL:BTCUSDT:1500:LIVE", state: "LIVE" }));
    expect(s.segment).toEqual({ id: "PERPETUAL:BTCUSDT:1500:GAP", state: "GAP" });
    s.apply(ladder(2_500, { id: "PERPETUAL:BTCUSDT:1500:LIVE", state: "LIVE" }));
    expect(s.segment).toEqual({ id: "PERPETUAL:BTCUSDT:1500:LIVE", state: "LIVE" });
    s.apply(view(3, true, 8_000, 1, "recent", 2_000, { id: "PERPETUAL:BTCUSDT:2000:LIVE", state: "LIVE" }));
    s.apply(walls(1, true, [], [], { id: "PERPETUAL:BTCUSDT:2000:GAP", state: "GAP" }));
    expect(s.segment).toEqual({ id: "PERPETUAL:BTCUSDT:2000:GAP", state: "GAP" });
  });

  it("trusted() needs a LIVE segment and every channel read in sync", () => {
    const { s } = store();
    expect(s.trusted()).toBe(false);
    s.apply(walls(1, true, [wall(1)]));
    s.apply(events(1, true, [hidden(1_000)]));
    s.apply(ladder(1_000));
    expect(s.trusted()).toBe(true);
    s.apply(events(1, true, [{ event: "segment", ts: 1_100, segment: "PERPETUAL:BTCUSDT:1100:GAP", state: "GAP", cause: "UNAVAILABLE" }]));
    expect(s.trusted()).toBe(false);
  });

  it("an ordered GAP event at the same millisecond as LIVE overrides a stale wall or ladder state", () => {
    const { s } = store();
    s.apply(walls(1, true, [wall(1)]));
    s.apply(events(0, true, []));
    expect(s.trusted()).toBe(true);
    s.apply(events(1, false, [{ event: "segment", ts: 1_000, segment: "PERPETUAL:BTCUSDT:1000:GAP", state: "GAP", cause: "UNAVAILABLE" }]));
    expect(s.trusted()).toBe(false);
    s.apply(ladder(1_001));
    expect(s.trusted()).toBe(false);
    s.apply(events(2, false, [{ event: "segment", ts: 1_000, segment: "PERPETUAL:BTCUSDT:1000:LIVE", state: "LIVE", cause: "RESYNC" }]));
    expect(s.trusted()).toBe(true);
  });

  it("a pair switch clears all four models even when no snapshot follows", () => {
    const { s } = store();
    s.apply(view(3, true, 4_000));
    s.apply(walls(1, true, [wall(1)]));
    s.apply(events(1, true, [hidden(1_000)]));
    s.apply(ladder(1_000));
    s.clear();
    expect(s.lanes.lanes()).toEqual([]);
    expect(s.walls.list()).toEqual([]);
    expect(s.events.since().events).toEqual([]);
    expect(s.ladder.ladder).toBeNull();
    expect(s.segment).toBeNull();
    for (const channel of ["l2_view", "l2_walls", "l2_events", "l2_ladder"] as const) expect(s.status(channel).synced).toBe(false);
  });

  it("a dropped socket keeps what is held but untrusted until the resets arrive", () => {
    const { s } = store();
    s.apply(walls(1, true, [wall(1)]));
    s.apply(events(1, true, [hidden(1_000)]));
    s.apply(ladder(1_000));
    s.markUntrusted();
    expect(s.walls.list()).toHaveLength(1);
    expect(s.trusted()).toBe(false);
    expect(s.ladder.ladder?.ts).toBe(1_000);
    expect(s.status("l2_ladder").synced).toBe(false);
    expect(s.apply(walls(2, false, [wall(2)]))).toBe(false);
    s.apply(walls(1, true, [wall(1)]));
    s.apply(events(1, true, [hidden(1_000)]));
    expect(s.trusted()).toBe(true);
    expect(s.status("l2_ladder").synced).toBe(false);
    s.apply(ladder(2_000));
    expect(s.status("l2_ladder").synced).toBe(true);
  });

  it("the version moves exactly when something was applied", () => {
    const { s } = store();
    const v0 = s.version;
    s.apply(walls(1, true, [wall(1)]));
    const v1 = s.version;
    s.apply(walls(1, false, [wall(1, 20)]));
    expect(v1).toBeGreaterThan(v0);
    expect(s.version).toBe(v1);
  });

  it("publishes a newly broken channel without treating its rejected frame as fresh", () => {
    const { s, clock } = store();
    clock.now = 100;
    s.apply(walls(1, true, [wall(1)]));
    const acceptedVersion = s.version;
    expect(s.status("l2_walls").lastFrameAt).toBe(100);
    clock.now = 200;
    expect(s.apply(walls(3, false, [wall(2)]))).toBe(false);
    expect(s.version).toBe(acceptedVersion + 1);
    expect(s.status("l2_walls")).toMatchObject({ synced: false, lastFrameAt: 100 });
    expect(s.apply(walls(4, false, [wall(3)]))).toBe(false);
    expect(s.version).toBe(acceptedVersion + 1);
  });
});
