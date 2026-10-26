import { describe, expect, it } from "vitest";
import { parseServerFrame, type L2WallWire } from "./frames";
import { wallOf } from "../lib/l2/types";

// Report 61 P4b. Every refusal the server's builders make
// (apps/runtime/test/server/l2-frames.test.js) is mirrored here, one case for
// one case, so the browser never admits what the runtime could not have
// built. The runtime's wire-parity property tests prove the other direction:
// everything the builders emit is admitted unchanged.

const BINANCE = { provider: "BINANCE", symbol: "BTC-USDT", marketKind: "PERPETUAL" } as const;
const DXFEED = { provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" } as const;
const SEGMENT = { id: "PERPETUAL:BTCUSDT:1000:LIVE", state: "LIVE" };

type Raw = Record<string, unknown>;

function view(overrides: Raw = {}): Raw {
  return {
    type: "l2_view", ...BINANCE, lane: 2, tier: "recent", ts: 4_000, seq: 7, reset: false, row_width: 0.5, column_ms: 4_000,
    columns: [{ ts: 4_000, lo: 100, hi: 102, bid: [[0, 1.5]], ask: [[2, 2]] }], segment: SEGMENT, ...overrides,
  };
}

function detail(overrides: Raw = {}): Raw {
  return {
    life_ms: null, first_shrink_ts: null, first_shrink_exact: false, reached_at_first_shrink: null, traded: 0, absorbed: 0,
    swept: 0, hidden: 0, cleared: 0, fill_ratio: 0, cross_side: 3, cross_side_share: 0.25, end_distance_rows: null,
    end_distance_pct: null, cleared_by_trades: false, continuity: null, repeats: 1, repeats_complete: false, evidence_gap: false,
    ...overrides,
  };
}

function wall(id: number, overrides: Raw = {}): Raw {
  return {
    id, side: "bid", row: 200, span: 1, start_ts: 1_000, end_ts: null, size: 12, peak: 12, ended_by: null, ratio: 4, chain: 0,
    fill: 0, eaten: 0, absorbing: false, detail: detail(), ...overrides,
  };
}

function walls(overrides: Raw = {}): Raw {
  return { type: "l2_walls", ...BINANCE, ts: 10_000, seq: 3, reset: false, row_width: 0.5, walls: [wall(5)], removed: [4], segment: SEGMENT, ...overrides };
}

const EVENTS: Raw[] = [
  { event: "segment", ts: 1_000, segment: "PERPETUAL:BTCUSDT:1000:LIVE", state: "LIVE", cause: null },
  { event: "wall_born", ts: 1_000, wall: 5, side: "bid", row: 200, span: 1, size: 12 },
  { event: "wall_trade", ts: 1_100, wall: 5, mode: "absorbed", price: 100, size: 2 },
  { event: "wall_hidden", ts: 1_150, wall: 5, volume: 1 },
  { event: "wall_shrink", ts: 1_200, wall: 5, exact: true, reached: true },
  { event: "trade", ts: 1_300, side: "ask", aggressor: "buy", mode: "swept", price: 101, size: 0.5, late: false },
  { event: "hidden", ts: 1_400, side: "bid", price: 100, volume: 0.25 },
  { event: "wall_end", ts: 1_500, wall: 5, ended_by: "filled", distance_rows: 0 },
];

function events(overrides: Raw = {}): Raw {
  return { type: "l2_events", ...BINANCE, ts: 2_000, seq: 20, reset: false, missed: 0, events: EVENTS, ...overrides };
}

function ladder(overrides: Raw = {}): Raw {
  return { type: "l2_ladder", ...DXFEED, ts: 5_000, depth: 3, bids: [[100, 1], [99.5, 2], [99, 3]], asks: [[100.5, 1], [101, 2]], segment: SEGMENT, ...overrides };
}

function without(raw: Raw, key: string): Raw {
  const copy = { ...raw };
  delete copy[key];
  return copy;
}

describe("L2 frames: the browser admits exactly what the runtime can build", () => {
  it("the base fixtures are admitted, so every refusal below is caused by its own change", () => {
    for (const frame of [view(), walls(), events(), ladder(), view({ ...DXFEED, provider: "DXFEED", marketKind: undefined })].map((raw) => JSON.parse(JSON.stringify(raw)))) {
      expect(parseServerFrame(frame)).not.toBeNull();
    }
  });

  it("returns the lane frame with its lane, tier and segment", () => {
    expect(parseServerFrame(view())).toMatchObject({ type: "l2_view", lane: 2, tier: "recent", seq: 7, segment: SEGMENT });
  });

  it.each([
    ["lane 0 (lane 0 stays on liquidity)", view({ lane: 0 })],
    ["lane 7", view({ lane: 7 })],
    ["a fractional lane", view({ lane: 1.5 })],
    ["an unknown tier", view({ tier: "coarse" })],
    ["a column with prints", view({ columns: [{ ts: 4_000, lo: 100, hi: 102, bid: [], ask: [], prints: [] }] })],
    ["a column with a prints floor", view({ columns: [{ ts: 4_000, lo: 100, hi: 102, bid: [], ask: [], prints_floor: 1 }] })],
    ["a segment with an unknown state", view({ segment: { id: "x", state: "HALT" } })],
    ["a segment with an empty id", view({ segment: { id: "", state: "LIVE" } })],
    ["a segment id over 160 characters", view({ segment: { id: "x".repeat(161), state: "LIVE" } })],
    ["a segment with an extra key", view({ segment: { ...SEGMENT, cause: null } })],
    ["an unknown provider", view({ provider: "OTHER" })],
    ["an increment with no column", view({ columns: [] })],
    ["a seq below its column count", view({ seq: 0 })],
    ["a missing segment", without(view(), "segment")],
    ["an extra key", view({ levels: [] })],
    ["a zero column width", view({ column_ms: 0 })],
  ])("l2_view: refuses %s", (_label, raw) => {
    expect(parseServerFrame(raw)).toBeNull();
  });

  it("l2_walls: life_ms is null exactly while a wall is active", () => {
    expect(parseServerFrame(walls({ walls: [wall(5, { detail: detail({ life_ms: 9_000 }) })] }))).toBeNull();
    const ended = wall(5, { end_ts: 9_000, ended_by: "pulled", detail: detail({ life_ms: 8_000 }) });
    expect(parseServerFrame(walls({ walls: [ended] }))).not.toBeNull();
    expect(parseServerFrame(walls({ walls: [{ ...ended, detail: detail({ life_ms: null }) }] }))).toBeNull();
    expect(parseServerFrame(walls({ walls: [wall(5, { detail: null })] }))).not.toBeNull();
  });

  it.each([
    ["a reset that also removes", walls({ reset: true, removed: [4] })],
    ["an increment that changes nothing", walls({ walls: [], removed: [] })],
    ["a duplicate id", walls({ walls: [wall(5), wall(5, { row: 300 })] })],
    ["an id both upserted and removed", walls({ removed: [5] })],
    ["a zero id", walls({ walls: [wall(0)] })],
    ["a duplicate removed id", walls({ walls: [], removed: [4, 4] })],
    ["more walls than the cap", walls({ reset: true, removed: [], walls: Array.from({ length: 1_001 }, (_, i) => wall(i + 1)) })],
    ["more removed ids than the cap", walls({ walls: [], removed: Array.from({ length: 1_001 }, (_, i) => i + 1) })],
    ["a fill ratio above 1", walls({ walls: [wall(5, { detail: detail({ fill_ratio: 1.2 }) })] })],
    ["a negative traded size", walls({ walls: [wall(5, { detail: detail({ traded: -1 }) })] })],
    ["zero repeats", walls({ walls: [wall(5, { detail: detail({ repeats: 0 }) })] })],
    ["a negative seq", walls({ seq: -1 })],
    ["a wall without its detail key", walls({ walls: [without(wall(5), "detail")] })],
    ["a detail with an extra key", walls({ walls: [wall(5, { detail: { ...detail(), extra: 1 } })] })],
    ["a continuity without gap_ms", walls({ walls: [wall(5, { detail: detail({ continuity: {} }) })] })],
    ["a wall that starts after the frame", walls({ walls: [wall(5, { start_ts: 10_001 })] })],
  ])("l2_walls: refuses %s", (_label, raw) => {
    expect(parseServerFrame(raw)).toBeNull();
  });

  it("l2_events: every kind survives with its fields, and a missed-only increment is admitted", () => {
    const parsed = parseServerFrame(events());
    expect(parsed?.type === "l2_events" ? parsed.events : null).toEqual(EVENTS);
    expect(parseServerFrame(events({ events: [], missed: 12 }))).not.toBeNull();
  });

  it.each([
    ["an unknown kind", events({ events: [{ event: "iceberg", ts: 1_000 }] })],
    ["an event after the frame ts", events({ events: [{ ...EVENTS[6], ts: 2_001 }] })],
    ["events out of time order", events({ events: [EVENTS[2], EVENTS[1]] })],
    ["a seq that counts fewer events than the frame holds", events({ seq: 7 })],
    ["an empty increment with nothing missed", events({ events: [], missed: 0 })],
    ["more events than the cap", events({ seq: 501, events: Array.from({ length: 501 }, () => EVENTS[6]) })],
    ["a wall trade with an unknown mode", events({ events: [{ ...EVENTS[2], mode: "iceberg" }] })],
    ["a trade whose aggressor is a book side", events({ events: [{ ...EVENTS[5], aggressor: "bid" }] })],
    ["an unknown verdict", events({ events: [{ ...EVENTS[7], ended_by: "vanished" }] })],
    ["a segment with an unknown state", events({ events: [{ ...EVENTS[0], state: "STALE" }] })],
    ["a negative missed count", events({ missed: -1 })],
    ["an event with an extra key", events({ events: [{ ...EVENTS[6], extra: 1 }] })],
    ["an event missing a key", events({ events: [without(EVENTS[6], "volume")] })],
    ["a zero price", events({ events: [{ ...EVENTS[6], price: 0 }] })],
  ])("l2_events: refuses %s", (_label, raw) => {
    expect(parseServerFrame(raw)).toBeNull();
  });

  it.each([
    ["bids not descending", ladder({ bids: [[99, 1], [100, 1]] })],
    ["asks not ascending", ladder({ asks: [[101, 1], [100.5, 1]] })],
    ["a repeated price", ladder({ bids: [[100, 1], [100, 2]] })],
    ["a crossed book", ladder({ bids: [[101, 1]], asks: [[100.5, 1]] })],
    ["a locked book", ladder({ bids: [[100.5, 1]], asks: [[100.5, 1]] })],
    ["more levels than depth", ladder({ depth: 2 })],
    ["depth above the cap", ladder({ depth: 51 })],
    ["a zero size", ladder({ bids: [[100, 0]] })],
    ["a level that is not a pair", ladder({ bids: [[100, 1, 2]] })],
    ["a missing segment", without(ladder(), "segment")],
  ])("l2_ladder: refuses %s", (_label, raw) => {
    expect(parseServerFrame(raw)).toBeNull();
  });

  it("l2_walls: a wall carries its lane when the runtime sent one and none when it did not (a client without lanes), the store reading that as lane 0; a lane past the widest or below zero is refused", () => {
    const frame = parseServerFrame(walls({ walls: [wall(5, { lane: 2 }), wall(6, { lane: 0 })] }));
    expect(frame).not.toBeNull();
    expect((frame as { walls: { id: number; lane: number }[] }).walls.map((w) => [w.id, w.lane])).toEqual([[5, 2], [6, 0]]);
    const legacy = parseServerFrame(walls({ walls: [without(wall(5), "lane")] })) as { walls: L2WallWire[] };
    expect(Object.hasOwn(legacy.walls[0], "lane")).toBe(false);
    expect(wallOf(legacy.walls[0]).lane).toBe(0);
    expect(parseServerFrame(walls({ walls: [wall(5, { lane: 7 })] }))).toBeNull();
    expect(parseServerFrame(walls({ walls: [wall(5, { lane: -1 })] }))).toBeNull();
    expect(parseServerFrame(walls({ walls: [wall(5, { lane: 1.5 })] }))).toBeNull();
  });
});
