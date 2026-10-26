import { describe, expect, it } from "vitest";
import { historicalL2, indicatorL2Of, type IndicatorL2 } from "../../../chart/indicatorL2";
import { L2Store, type L2Frame } from "../../../l2/l2Store";
import type { LiquidityGrid } from "../../passive-liquidity/liquidityGrid";
import { parseServerFrame } from "../../../../types/frames";
import { mitigatedWalls, standingWalls, type BarClose, type TrackerRules } from "../bandTracker";
import { adoptHistory, bandOf, createEngineWalls, isApproximate, readEngine, type EngineWallsState } from "../engineWalls";
import { HELD_MS, MEMORY_MS } from "../institutionalV2Rules";

const T = 1_700_000_000_000;
const S = 1_000;
const ID = { provider: "BINANCE", symbol: "BTC-USDT", marketKind: "PERPETUAL" } as const;
const LIVE = { id: "PERPETUAL:BTCUSDT:1000:LIVE", state: "LIVE" };
const RULES: TrackerRules = { bandRows: 4, wallSize: 10, strongSize: Infinity };

interface WallSpec {
  side?: "bid" | "ask";
  row?: number;
  span?: number;
  size?: number;
  peak?: number;
  start?: number;
  end?: number | null;
  endedBy?: "filled" | "partial" | "hit" | "pulled" | "moved" | null;
  traded?: number;
  eatenShare?: number;
}

function parse(raw: Record<string, unknown>): L2Frame {
  const frame = parseServerFrame(raw);
  if (frame === null) throw new Error(`fixture rejected: ${JSON.stringify(raw)}`);
  return frame as L2Frame;
}

function wallWire(id: number, spec: WallSpec = {}): Record<string, unknown> {
  const size = spec.size ?? 12;
  const start = spec.start ?? T;
  const end = spec.end ?? null;
  return {
    id, side: spec.side ?? "bid", row: spec.row ?? 200, span: spec.span ?? 1, start_ts: start, end_ts: end, size,
    peak: spec.peak ?? Math.max(size, 12), ended_by: spec.endedBy ?? null, ratio: 4, chain: 0, fill: 0, eaten: spec.eatenShare ?? 0, absorbing: false,
    detail: {
      life_ms: end === null ? null : end - start, first_shrink_ts: null, first_shrink_exact: false, reached_at_first_shrink: null, traded: spec.traded ?? 0, absorbed: spec.traded ?? 0, swept: 0, hidden: 0, cleared: 0,
      fill_ratio: 0, cross_side: 0, cross_side_share: 0, end_distance_rows: null, end_distance_pct: null, cleared_by_trades: false, continuity: null, repeats: 1, repeats_complete: false, evidence_gap: false,
    },
  };
}

class Feed {
  readonly store = new L2Store();
  readonly l2: IndicatorL2;
  private _wallSeq = 0;
  private _eventSeq = 0;

  window: { lo: number; hi: number } | null = null;

  constructor(segment: Record<string, unknown> = LIVE) {
    this.walls([], { reset: true, segment });
    this.events([], { reset: true });
    this.l2 = indicatorL2Of(this.store, () => this.grid())!;
  }

  private grid(): LiquidityGrid | null {
    if (this.window === null) return null;
    return { columns: [{ ts: T, lo: this.window.lo, hi: this.window.hi }], rowWidth: 1, columnMs: S, deepColumnMs: 10 * S } as unknown as LiquidityGrid;
  }

  walls(list: Record<string, unknown>[], { ts = T, reset = false, removed = [] as number[], segment = LIVE as Record<string, unknown> | null } = {}): void {
    this._wallSeq += 1;
    this.store.apply(parse({ type: "l2_walls", ...ID, ts, seq: this._wallSeq, reset, row_width: 1, walls: list, removed, segment }));
  }

  events(list: Record<string, unknown>[], { reset = false, missed = 0 } = {}): void {
    this._eventSeq += list.length;
    const ts = list.reduce((latest, event) => Math.max(latest, Number(event.ts)), T);
    this.store.apply(parse({ type: "l2_events", ...ID, ts, seq: this._eventSeq, reset, missed, events: list }));
  }

  trade(wall: number, ts: number, size: number): Record<string, unknown> {
    return { event: "wall_trade", ts, wall, mode: "absorbed", price: 200, size };
  }
}

function read(state: EngineWallsState, feed: Feed, nowTs = T + 5 * S, closes: readonly BarClose[] = []) {
  return readEngine(state, feed.l2, RULES, nowTs, closes);
}

describe("engine walls: trust and availability", () => {
  it("names why it cannot read: no l2, Historical Mode, an untrusted feed", () => {
    const state = createEngineWalls();
    expect(readEngine(state, undefined, RULES, T)).toBe("no-l2");
    expect(readEngine(state, historicalL2(), RULES, T)).toBe("historical");
    const feed = new Feed();
    feed.walls([wallWire(1)]);
    expect(read(state, feed)).toBeNull();
    expect(state.open.size).toBe(1);
    feed.store.markUntrusted();
    expect(read(state, feed)).toBe("untrusted");
    expect(state.open.size).toBe(1);
    expect(state.reason).toBe("untrusted");
  });
});

describe("engine walls: a band from the engine's walls", () => {
  it("opens a band from a wall at or above wallSize, ignores one under it, and sums two walls in one band", () => {
    const feed = new Feed();
    feed.walls([wallWire(1, { row: 200, size: 6 }), wallWire(2, { row: 201, size: 5 }), wallWire(3, { side: "ask", row: 300, size: 9 })]);
    const state = createEngineWalls();
    read(state, feed);
    expect([...state.open.keys()]).toEqual(["bid:50"]);
    const wall = state.open.get("bid:50")!;
    expect(wall).toMatchObject({ side: "bid", band: 50, bandRows: 4, current: 11, peak: 11, startTs: T, refills: 0, eaten: 0 });
  });

  it("puts a wall in the band of its middle row and keeps the engine's start time", () => {
    expect(bandOf({ row: 202, span: 4 }, 4)).toBe(50);
    expect(bandOf({ row: 203, span: 4 }, 4)).toBe(51);
    const feed = new Feed();
    feed.walls([wallWire(1, { row: 203, span: 4, start: T - 90 * S })]);
    const state = createEngineWalls();
    read(state, feed);
    expect(state.open.get("bid:51")?.startTs).toBe(T - 90 * S);
  });

  it("follows a birth the engine moves back once a replayed window reaches further, and never one that moves forward", () => {
    const feed = new Feed();
    feed.walls([wallWire(1, { row: 203, span: 4, start: T - 90 * S })]);
    const state = createEngineWalls();
    read(state, feed);
    feed.walls([wallWire(1, { row: 203, span: 4, start: T - 3_600 * S })]);
    read(state, feed);
    expect(state.open.get("bid:51")).toMatchObject({ startTs: T - 3_600 * S, resumedTs: T - 3_600 * S });
    feed.walls([wallWire(1, { row: 203, span: 4, start: T - 60 * S })]);
    read(state, feed);
    expect(state.open.get("bid:51")?.startTs).toBe(T - 3_600 * S);
  });

  it("tracks current, peak, low and a refill by the tracker's own rule", () => {
    const feed = new Feed();
    const state = createEngineWalls();
    feed.walls([wallWire(1, { size: 12 })]);
    read(state, feed);
    feed.walls([wallWire(1, { size: 5, peak: 12 })], { ts: T + S });
    read(state, feed);
    expect(state.open.get("bid:50")).toMatchObject({ current: 5, peak: 12, low: 5, refills: 0 });
    feed.walls([wallWire(1, { size: 11, peak: 12 })], { ts: T + 2 * S });
    read(state, feed);
    expect(state.open.get("bid:50")).toMatchObject({ current: 11, low: 11, refills: 1, refilled: 6 });
  });

  it("reads eaten as the traded amount from detail, never the wire's eaten share", () => {
    const feed = new Feed();
    const state = createEngineWalls();
    feed.walls([wallWire(1, { size: 12 })]);
    read(state, feed);
    feed.walls([wallWire(1, { size: 8, peak: 12, traded: 6, eatenShare: 0.5 })], { ts: T + S });
    read(state, feed);
    expect(state.open.get("bid:50")?.eaten).toBe(6);
  });

  it("counts everything a wall had traded when the page loads with it already standing", () => {
    const feed = new Feed();
    const state = createEngineWalls();
    feed.walls([wallWire(1, { size: 12, traded: 8, start: T - 600 * S })]);
    read(state, feed);
    expect(state.open.get("bid:50")).toMatchObject({ eaten: 8, startTs: T - 600 * S });
  });

  it("counts only what traded after the band opened, as the tracker does", () => {
    const feed = new Feed();
    const state = createEngineWalls();
    feed.walls([wallWire(1, { size: 6, traded: 3 })]);
    read(state, feed);
    expect(state.open.size).toBe(0);
    feed.walls([wallWire(1, { size: 6, traded: 3 }), wallWire(2, { row: 201, size: 6 })], { ts: T + S });
    read(state, feed);
    expect(state.open.get("bid:50")?.eaten).toBe(0);
    feed.walls([wallWire(1, { size: 6, traded: 5 }), wallWire(2, { row: 201, size: 6 })], { ts: T + 2 * S });
    read(state, feed);
    expect(state.open.get("bid:50")?.eaten).toBe(2);
  });

  it("keeps a wall's traded amount after the engine ends it, so the band's eaten never drops", () => {
    const feed = new Feed();
    const state = createEngineWalls();
    feed.walls([wallWire(1, { size: 12 }), wallWire(2, { row: 201, size: 12 })]);
    read(state, feed);
    feed.walls([wallWire(1, { size: 12, traded: 4 }), wallWire(2, { row: 201, size: 12, traded: 3 })], { ts: T + S });
    read(state, feed);
    expect(state.open.get("bid:50")?.eaten).toBe(7);
    feed.walls([wallWire(1, { size: 12, traded: 4 }), wallWire(2, { row: 201, size: 0, end: T + 2 * S, endedBy: "filled", traded: 9 })], { ts: T + 2 * S });
    read(state, feed);
    expect(state.open.get("bid:50")).toMatchObject({ current: 12, eaten: 13 });
  });
});

describe("engine walls: the moment a wall was crossed", () => {
  it("takes crossedTs from the wall_trade event that crossed 60 % of the peak when the events are complete", () => {
    const feed = new Feed();
    const state = createEngineWalls();
    feed.walls([wallWire(1, { size: 20, peak: 20 })]);
    read(state, feed);
    feed.events([feed.trade(1, T + 3 * S, 7), feed.trade(1, T + 4 * S, 6)]);
    feed.walls([wallWire(1, { size: 7, peak: 20, traded: 13 })], { ts: T + 5 * S });
    read(state, feed);
    const wall = state.open.get("bid:50")!;
    expect(wall.crossedTs).toBe(T + 4 * S);
    expect(isApproximate(state, wall)).toBe(false);
  });

  it("adds the events on top of what the wall had already eaten", () => {
    const feed = new Feed();
    const state = createEngineWalls();
    feed.walls([wallWire(1, { size: 20, peak: 20 })]);
    read(state, feed);
    feed.walls([wallWire(1, { size: 12, peak: 20, traded: 8 })], { ts: T + 2 * S });
    read(state, feed);
    feed.events([feed.trade(1, T + 3 * S, 2), feed.trade(1, T + 4 * S, 3)]);
    feed.walls([wallWire(1, { size: 7, peak: 20, traded: 13 })], { ts: T + 5 * S });
    read(state, feed);
    expect(state.open.get("bid:50")?.crossedTs).toBe(T + 4 * S);
  });

  it("falls back to the frame time and says so when the event ring is incomplete", () => {
    const feed = new Feed();
    const state = createEngineWalls();
    feed.walls([wallWire(1, { size: 20, peak: 20 })]);
    read(state, feed);
    feed.events([feed.trade(1, T + 4 * S, 6)], { missed: 3 });
    feed.walls([wallWire(1, { size: 7, peak: 20, traded: 13 })], { ts: T + 5 * S });
    read(state, feed);
    const wall = state.open.get("bid:50")!;
    expect(wall.crossedTs).toBe(T + 5 * S);
    expect(isApproximate(state, wall)).toBe(true);
  });
});

describe("engine walls: strength and guard stay our rules", () => {
  it("is strong at strongSize, loses it under the keep share, and earns the guard after reaching strong and giving a quarter of its peak", () => {
    const feed = new Feed();
    const state = createEngineWalls();
    const rules: TrackerRules = { ...RULES, strongSize: 40 };
    feed.walls([wallWire(1, { size: 40, peak: 40 })]);
    readEngine(state, feed.l2, rules, T);
    expect(state.open.get("bid:50")).toMatchObject({ atStrongSize: true, reachedStrongSize: true, guarded: false });
    feed.walls([wallWire(1, { size: 30, peak: 40, traded: 10 })], { ts: T + S });
    readEngine(state, feed.l2, rules, T + S);
    expect(state.open.get("bid:50")).toMatchObject({ atStrongSize: false, reachedStrongSize: true, guarded: true });
  });
});

describe("engine walls: how a band ends", () => {
  it.each(["pulled", "hit", "moved"] as const)("ends as pulled when the engine says %s and nothing traded, and resumes with a refill when the band comes back", (verdict) => {
    const feed = new Feed();
    const state = createEngineWalls();
    feed.walls([wallWire(1, { size: 12 })]);
    read(state, feed);
    feed.walls([wallWire(1, { size: 0, peak: 12, end: T + S, endedBy: verdict })], { ts: T + S });
    read(state, feed);
    expect(state.open.size).toBe(0);
    expect(state.memory.get("bid:50")).toMatchObject({ endReason: "pulled", endTs: T + S, current: 0 });
    feed.walls([wallWire(2, { size: 15, start: T + 30 * S })], { ts: T + 30 * S });
    read(state, feed);
    expect(state.open.get("bid:50")).toMatchObject({ startTs: T, resumedTs: T + 30 * S, refills: 1, refilled: 15, peak: 15, endTs: null });
  });

  it("ends as pulled when the wall drops off the list with no verdict and nothing traded", () => {
    const feed = new Feed();
    const state = createEngineWalls();
    feed.walls([wallWire(1, { size: 12 })]);
    read(state, feed);
    feed.walls([], { ts: T + S, removed: [1] });
    read(state, feed);
    expect(state.memory.get("bid:50")?.endReason).toBe("pulled");
  });

  it("keeps an eaten wall open at zero when it drops off the list with no verdict", () => {
    const feed = new Feed();
    const state = createEngineWalls();
    feed.walls([wallWire(1, { size: 12 })]);
    read(state, feed);
    feed.walls([wallWire(1, { size: 12, traded: 5 })], { ts: T + S });
    read(state, feed);
    feed.walls([], { ts: T + 2 * S, removed: [1] });
    read(state, feed);
    expect(state.open.get("bid:50")).toMatchObject({ current: 0, eaten: 5, endTs: null });
    expect(state.memory.size).toBe(0);
  });

  it("keeps an eaten wall open at zero until a candle closes through it, as the tracker does", () => {
    const feed = new Feed();
    const state = createEngineWalls();
    feed.walls([wallWire(1, { size: 12 })]);
    read(state, feed);
    feed.walls([wallWire(1, { size: 0, peak: 12, end: T + S, endedBy: "filled", traded: 11 })], { ts: T + S });
    read(state, feed);
    expect(state.open.get("bid:50")).toMatchObject({ current: 0, eaten: 11, endTs: null });
    expect(mitigatedWalls(state)).toEqual([]);
    read(state, feed, T + HELD_MS + 2 * S, [{ ts: T + HELD_MS + S, row: 190 }]);
    expect(state.open.size).toBe(0);
    expect(mitigatedWalls(state)).toHaveLength(1);
    expect(state.memory.get("bid:50")).toMatchObject({ endReason: "closed", endTs: T + HELD_MS + S });
  });

  it("never lets a candle that closed before a band was born end it, and still lets a later one", () => {
    const feed = new Feed();
    const state = createEngineWalls();
    feed.walls([wallWire(1, { size: 12, start: T })]);
    read(state, feed, T + S, [{ ts: T - 3_600 * S, row: 190 }]);
    expect(state.open.get("bid:50")).toMatchObject({ endTs: null });
    read(state, feed, T + 3 * S, [{ ts: T - 3_600 * S, row: 190 }, { ts: T + 2 * S, row: 190 }]);
    expect(state.memory.get("bid:50")).toMatchObject({ endReason: "closed", endTs: T + 2 * S });
  });

  it("invalidates a remembered wall when a candle closes through it, so it never resumes", () => {
    const feed = new Feed();
    const state = createEngineWalls();
    feed.walls([wallWire(1, { size: 12 })]);
    read(state, feed);
    feed.walls([wallWire(1, { size: 0, peak: 12, end: T + S, endedBy: "pulled" })], { ts: T + S });
    read(state, feed, T + 2 * S, [{ ts: T + 2 * S, row: 190 }]);
    expect(state.memory.get("bid:50")?.endReason).toBe("invalidated");
    feed.walls([wallWire(2, { size: 15, start: T + 30 * S })], { ts: T + 30 * S });
    read(state, feed, T + 30 * S);
    expect(state.open.get("bid:50")).toMatchObject({ startTs: T + 30 * S, refills: 0 });
  });

  it("a candle that closed before a remembered wall ended does not invalidate it", () => {
    const feed = new Feed();
    const state = createEngineWalls();
    feed.walls([wallWire(1, { size: 12 })]);
    read(state, feed);
    feed.walls([wallWire(1, { size: 0, peak: 12, end: T + S, endedBy: "pulled" })], { ts: T + S });
    read(state, feed);
    read(state, feed, T + 3 * S, [{ ts: T, row: 190 }]);
    expect(state.memory.get("bid:50")?.endReason).toBe("pulled");
    read(state, feed, T + 3 * S, [{ ts: T, row: 190 }, { ts: T + 2 * S, row: 190 }]);
    expect(state.memory.get("bid:50")?.endReason).toBe("invalidated");
  });

  it("forgets a remembered wall after the memory window", () => {
    const feed = new Feed();
    const state = createEngineWalls();
    feed.walls([wallWire(1, { size: 12 })]);
    read(state, feed);
    feed.walls([wallWire(1, { size: 0, peak: 12, end: T + S, endedBy: "pulled" })], { ts: T + S });
    read(state, feed);
    feed.walls([], { ts: T + S + MEMORY_MS + S, removed: [1] });
    read(state, feed, T + S + MEMORY_MS + S);
    expect(state.memory.size).toBe(0);
  });

  it("only a wall held three minutes is standing", () => {
    const feed = new Feed();
    const state = createEngineWalls();
    feed.walls([wallWire(1, { size: 12, start: T })]);
    read(state, feed);
    expect(standingWalls(state, T + HELD_MS - S)).toEqual([]);
    expect(standingWalls(state, T + HELD_MS)).toHaveLength(1);
  });
});

describe("engine walls: walls that ended before the adapter ever saw them", () => {
  it("adopts an eaten past wall as a band open at nothing from its own birth, so the candle that closed through it makes it mitigated", () => {
    const feed = new Feed();
    const state = createEngineWalls();
    feed.walls([wallWire(1, { size: 0, peak: 30, start: T - 3_600 * S, end: T - 3_000 * S, endedBy: "filled", traded: 28 })]);
    read(state, feed, T, [{ ts: T - 2_900 * S, row: 190 }]);
    expect(state.open.size).toBe(0);
    expect(state.memory.get("bid:50")).toMatchObject({ startTs: T - 3_600 * S, peak: 30, eaten: 28, current: 0, endReason: "closed", endTs: T - 2_900 * S });
    expect(mitigatedWalls(state)).toHaveLength(1);
  });

  it("adopts a pulled past wall as a memory, ready to resume, and never twice", () => {
    const feed = new Feed();
    const state = createEngineWalls();
    feed.walls([wallWire(1, { size: 0, peak: 30, start: T - 3_600 * S, end: T - 3_000 * S, endedBy: "pulled" })]);
    read(state, feed, T);
    expect(state.memory.get("bid:50")).toMatchObject({ startTs: T - 3_600 * S, endReason: "pulled", endTs: T - 3_000 * S, refills: 0 });
    feed.walls([wallWire(1, { size: 0, peak: 30, start: T - 3_600 * S, end: T - 3_000 * S, endedBy: "pulled" }), wallWire(2, { size: 15, start: T + S })], { ts: T + S });
    read(state, feed, T + S);
    expect(state.open.get("bid:50")).toMatchObject({ startTs: T - 3_600 * S, resumedTs: T + S, refills: 1, peak: 15 });
    feed.walls([wallWire(1, { size: 0, peak: 30, start: T - 3_600 * S, end: T - 3_000 * S, endedBy: "pulled" }), wallWire(2, { size: 16, start: T + S })], { ts: T + 2 * S });
    read(state, feed, T + 2 * S);
    expect(state.open.get("bid:50")?.refills).toBe(1);
  });

  it("ignores a past wall under wallSize and never adopts one it already tracked", () => {
    const feed = new Feed();
    const state = createEngineWalls();
    feed.walls([wallWire(1, { size: 0, peak: 8, start: T - 600 * S, end: T - 300 * S, endedBy: "pulled" }), wallWire(2, { size: 12 })]);
    read(state, feed, T);
    expect(state.memory.size).toBe(0);
    expect(state.open.size).toBe(1);
    feed.walls([wallWire(2, { size: 0, peak: 12, end: T + S, endedBy: "pulled" })], { ts: T + S });
    read(state, feed, T + S);
    expect(state.memory.get("bid:50")?.endTs).toBe(T + S);
    feed.walls([wallWire(2, { size: 0, peak: 12, end: T + S, endedBy: "pulled" })], { ts: T + 2 * S, removed: [] });
    read(state, feed, T + 2 * S);
    expect(state.memory.get("bid:50")).toMatchObject({ endTs: T + S, refills: 0 });
  });
});

describe("engine walls: segments, pair switches and idle reads", () => {
  it("ends every unguarded wall as a hole when the same pair starts a new segment, and keeps the guarded one", () => {
    const feed = new Feed();
    const state = createEngineWalls();
    const rules: TrackerRules = { ...RULES, strongSize: 40 };
    feed.walls([wallWire(1, { size: 40, peak: 40 }), wallWire(2, { side: "ask", row: 300, size: 12 })]);
    readEngine(state, feed.l2, rules, T);
    feed.walls([wallWire(1, { size: 40, peak: 40, traded: 10 }), wallWire(2, { side: "ask", row: 300, size: 12 })], { ts: T + S });
    readEngine(state, feed.l2, rules, T + S);
    expect(state.open.get("bid:50")?.guarded).toBe(true);
    const later = { id: "PERPETUAL:BTCUSDT:9000:LIVE", state: "LIVE" };
    feed.walls([wallWire(3, { size: 40, peak: 40, traded: 10, start: T + 20 * S })], { ts: T + 20 * S, reset: true, segment: later });
    readEngine(state, feed.l2, rules, T + 20 * S);
    expect(state.open.get("bid:50")).toMatchObject({ startTs: T, resumedTs: T, guarded: true, endReason: null });
    expect(state.memory.get("ask:75")).toMatchObject({ endReason: "hole", endTs: T + S });
  });

  it("a band that comes back after a hole keeps what it had eaten and adds to it", () => {
    const feed = new Feed();
    const state = createEngineWalls();
    feed.walls([wallWire(1, { size: 12 })]);
    read(state, feed);
    feed.walls([wallWire(1, { size: 12, traded: 4 })], { ts: T + S });
    read(state, feed);
    const later = { id: "PERPETUAL:BTCUSDT:9000:LIVE", state: "LIVE" };
    feed.walls([wallWire(5, { size: 12, traded: 1, start: T + 20 * S })], { ts: T + 20 * S, reset: true, segment: later });
    read(state, feed, T + 20 * S);
    expect(state.open.get("bid:50")).toMatchObject({ eaten: 5, startTs: T, resumedTs: T + 20 * S, refills: 0 });
    feed.walls([wallWire(5, { size: 12, traded: 3, start: T + 20 * S })], { ts: T + 21 * S, segment: later });
    read(state, feed, T + 21 * S);
    expect(state.open.get("bid:50")?.eaten).toBe(7);
  });

  it("ends a band whose rows left the heatmap window, but never a guarded one", () => {
    const feed = new Feed();
    feed.window = { lo: 150, hi: 260 };
    const state = createEngineWalls();
    const rules: TrackerRules = { ...RULES, strongSize: 40 };
    feed.walls([wallWire(1, { size: 12 }), wallWire(2, { row: 240, size: 40, peak: 40 })]);
    readEngine(state, feed.l2, rules, T);
    feed.walls([wallWire(1, { size: 0, peak: 12, end: T + S, endedBy: "filled", traded: 11 }), wallWire(2, { row: 240, size: 40, peak: 40, traded: 10 })], { ts: T + S });
    readEngine(state, feed.l2, rules, T + S);
    expect(state.open.get("bid:50")).toMatchObject({ current: 0, eaten: 11, endTs: null });
    expect(state.open.get("bid:60")?.guarded).toBe(true);
    feed.window = { lo: 300, hi: 400 };
    feed.walls([wallWire(2, { row: 240, size: 40, peak: 40, traded: 10 })], { ts: T + 2 * S });
    readEngine(state, feed.l2, rules, T + 2 * S);
    expect(state.memory.get("bid:50")).toMatchObject({ endReason: "window", endTs: T + 2 * S });
    expect(state.open.has("bid:60")).toBe(true);
  });

  it("clears everything, memory included, when the segment belongs to another pair", () => {
    const feed = new Feed();
    const state = createEngineWalls();
    feed.walls([wallWire(1, { size: 12 })]);
    read(state, feed);
    feed.walls([wallWire(1, { size: 0, peak: 12, end: T + S, endedBy: "pulled" })], { ts: T + S });
    read(state, feed);
    expect(state.memory.size).toBe(1);
    feed.walls([], { ts: T + 2 * S, reset: true, segment: { id: "SPOT:ETHUSDT:2000:LIVE", state: "LIVE" } });
    read(state, feed);
    expect(state.open.size).toBe(0);
    expect(state.memory.size).toBe(0);
  });

  it("does no work when the version has not moved, but still applies new candle closes", () => {
    const feed = new Feed();
    const state = createEngineWalls();
    feed.walls([wallWire(1, { size: 12 })]);
    let reads = 0;
    const counting: IndicatorL2 = { ...feed.l2, walls: () => (reads += 1, feed.l2.walls()), get version() { return feed.l2.version; } };
    readEngine(state, counting, RULES, T);
    readEngine(state, counting, RULES, T + S);
    expect(reads).toBe(1);
    readEngine(state, counting, RULES, T + 2 * S, [{ ts: T + 2 * S, row: 190 }]);
    expect(reads).toBe(1);
    expect(state.memory.get("bid:50")?.endReason).toBe("closed");
  });

  it("adopts past walls from the history as it adopts the wire's ended walls, by their own negative ids, and never a live id through that door", () => {
    const feed = new Feed();
    const state = createEngineWalls();
    read(state, feed);
    const past = (id: number, over: Partial<WallSpec> = {}) => {
      const raw = wallWire(Math.abs(id), { row: 203, span: 4, start: T - 3_600 * S, end: T - 1_800 * S, endedBy: "pulled", size: 0, peak: 20, ...over });
      return { id, lane: 0, side: raw.side as "bid", row: raw.row as number, span: raw.span as number, startTs: raw.start_ts as number, endTs: raw.end_ts as number, size: raw.size as number, peak: raw.peak as number, endedBy: raw.ended_by as "pulled", ratio: 4, chain: 0, fill: 0, eaten: 0, absorbing: false, detail: null };
    };
    expect(adoptHistory(state, [past(-1), past(7)], RULES)).toBe(1);
    expect(state.memory.get("bid:51")).toMatchObject({ startTs: T - 3_600 * S, endTs: T - 1_800 * S, endReason: "pulled" });
    expect(state.adopted.has(-1)).toBe(true);
    expect(state.adopted.has(7)).toBe(false);
    expect(adoptHistory(state, [past(-1)], RULES)).toBe(0);
  });

  it("ends a history wall on the candle closes that went through it even when the answer arrives after those closes were read (PR #31 review)", () => {
    const source = new Feed();
    source.walls([
      wallWire(5, { row: 203, span: 4, size: 0, peak: 30, start: T - 3_600 * S, end: T - 3_000 * S, endedBy: "filled", traded: 28 }),
      wallWire(6, { row: 303, span: 4, size: 0, peak: 30, start: T - 3_600 * S, end: T - 3_000 * S, endedBy: "pulled" }),
    ]);
    const [traded, pulled] = source.l2.walls().map((wall) => ({ ...wall, id: -wall.id }));
    const closes: BarClose[] = [{ ts: T - 2_900 * S, row: 150 }];
    const tradedKey = `bid:${bandOf(traded, RULES.bandRows)}`;
    const pulledKey = `bid:${bandOf(pulled, RULES.bandRows)}`;
    const early = createEngineWalls();
    adoptHistory(early, [traded, pulled], RULES, closes);
    read(early, new Feed(), T, closes);
    const late = createEngineWalls();
    read(late, new Feed(), T, closes);
    expect(late.closedTs).toBe(T - 2_900 * S);
    adoptHistory(late, [traded, pulled], RULES, closes);
    for (const state of [early, late]) {
      expect(state.open.size).toBe(0);
      expect(state.memory.get(tradedKey)).toMatchObject({ endReason: "closed", endTs: T - 2_900 * S, eaten: 28 });
      expect(state.memory.get(pulledKey)).toMatchObject({ endReason: "invalidated" });
      expect(standingWalls(state, T)).toEqual([]);
    }
  });

  it("a history wall born after the last close read takes no close from before its birth", () => {
    const source = new Feed();
    source.walls([wallWire(5, { row: 203, span: 4, size: 0, peak: 30, start: T - 1_000 * S, end: T - 500 * S, endedBy: "filled", traded: 28 })]);
    const [traded] = source.l2.walls().map((wall) => ({ ...wall, id: -wall.id }));
    const closes: BarClose[] = [{ ts: T - 2_900 * S, row: 150 }];
    const state = createEngineWalls();
    read(state, new Feed(), T, closes);
    adoptHistory(state, [traded], RULES, closes);
    expect([...state.open.values()].map((wall) => [wall.startTs, wall.endReason])).toEqual([[T - 1_000 * S, null]]);
  });
});
