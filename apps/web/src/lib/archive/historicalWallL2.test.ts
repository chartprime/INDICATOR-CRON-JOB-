import { describe, expect, it } from "vitest";
import { historicalBookL2 } from "./historicalBookL2";
import { historicalBookLiquidity } from "./historicalBookLiquidity";
import { HistoricalLiquidityGrid } from "./historicalLiquidityGrid";
import { historicalWallL2 } from "./historicalWallL2";
import { historicalPrints } from "./historicalPrints";
import { HISTORICAL_L2_PROFILES, type HistoricalL2Row } from "./historicalL2Client";
import type { HistoricalBookSecond } from "./historicalL2States";
import { createEngineWalls, readEngine } from "../indicators/institutional-order-blocks-v2/engineWalls";
import { WhaleWallStore } from "../indicators/whale-limit-order-heatmap/wallStore";

const instrument = HISTORICAL_L2_PROFILES[0], derivation = "d".repeat(64), profile = { id: "a".repeat(64), minimumSize: 40, sampleMs: 1000 };
const ns = (time: number) => String(BigInt(time) * 1000000n);
const second = (time: number): HistoricalBookSecond => ({ openNs: ns(time - 1000), closeNs: ns(time), knownNs: ns(time),
  knownKey: null, segmentId: "b".repeat(64), complete: true, trusted: true, reason: "OBSERVED_PREFIX",
  flow: { BUY: 0, SELL: 0, UNKNOWN: 0, count: 0 },
  column: { ts: time - 1000, lo: 400, hi: 404, bid: new Float64Array([80, 0, NaN, NaN, NaN]), ask: new Float64Array([NaN, NaN, NaN, 0, 40]), buy: [], sell: [] } });
const wall = (ended = false) => ({ id: 1, side: "bid", row: 400, span: 1, startTs: 500, endTs: ended ? 1500 : null,
  size: ended ? 0 : 80, peak: 80, endedBy: ended ? "filled" : null, ratio: 4, chain: 0, fill: 0, eaten: ended ? 80 : 0, absorbing: false, detail: null });
function sample(time: number, index: number, ended = false, segment = "b".repeat(64)): HistoricalL2Row {
  return { schema: "historical-l2-wall-record/1", instrument_id: instrument, derivation_id: derivation,
    append_position: String(index), known_ns: ns(time), known_key: [ns(time - 1), "2", String(index), "0"],
    payload: { schema: "historical-l2-wall-view/2", instrument_id: instrument, derivation_id: derivation,
      known_ns: ns(time), profile_id: profile.id, segment_id: segment, walls: [wall(ended)],
      lifecycle: [{ kind: "wall_trade", ts: time - 1, wall: 1, trade: "absorbed", price: 100, size: 1 }], trades: [], wall_trades: [] } };
}
function print(time: number, index: number, side = "BUY", known = time): HistoricalL2Row {
  const key = [ns(time), "2", String(index), "0"];
  return { schema: "historical-l2-print-record/1", instrument_id: instrument, derivation_id: derivation,
    append_position: String(index), known_ns: ns(known), known_key: key, payload: { schema: "historical-l2-source-print/1",
      known_ns: ns(known), event_ns: ns(time), known_key: key, side, price: "100.0001", size: index + 1, record_id: String(index + 1).padStart(64, "0") } };
}

describe("historical walls and exact individual trades", () => {
  it("preserves native wall fields, never leaks later ends, and rewinds to the same evidence", () => {
    const input = historicalWallL2(historicalBookL2([second(1000), second(2000)], 0.25, 1), [sample(1000, 0), sample(2000, 1, true)], 1, profile);
    const early = input.atTime!(1000);
    expect(early.walls()[0]).toMatchObject({ startTs: 500, endTs: null, id: 1000001 });
    expect(early.historicalWalls!()[0].endTs).toBeNull();
    expect(input.historicalWalls!()[0].endTs).toBe(1500);
    expect(input.atTime!(1000).historicalWalls!()).toEqual(early.historicalWalls!());
    expect(early.atTime!(2000).walls()[0].endTs).toBeNull();
    expect(input.notionalMultiplier).toBe(50);
    expect(input.events(1).events).toHaveLength(1);
    expect(early.events(1).events).toHaveLength(0);
  });
  it("resets trust and event sequences across segment closures instead of inventing continuous history", () => {
    const close = { ...sample(2000, 1), known_key: null, payload: { schema: "historical-l2-wall-segment-end/2", known_ns: ns(2000),
      profile_id: profile.id, segment_id: "b".repeat(64), cause: "gap" } };
    const input = historicalWallL2(historicalBookL2([second(1000), second(2000), second(3000)], 0.25, 1),
      [sample(1000, 0), close, sample(3000, 2, false, "c".repeat(64))], 1, profile);
    expect(input.atTime!(2000).trusted()).toBe(false);
    expect(input.atTime!(2000).walls()).toEqual([]);
    expect(input.events().seq).toBe(1);
    expect(input.walls()[0].id).toBe(2000001);
    const state = createEngineWalls(), rules = { bandRows: 1, wallSize: 40, strongSize: 60 };
    readEngine(state, input.atTime!(1000), rules, 1000);
    readEngine(state, input, rules, 3000);
    expect(state.segmentId).toBe("c".repeat(64));
    expect([...state.ids.keys()]).toEqual([2000001]);
  });
  it("refuses wrong profiles, future outcomes, swapped identities and regressing rows", () => {
    const base = historicalBookL2([second(1000), second(2000)], 0.25, 1);
    expect(() => historicalWallL2(base, [sample(1000, 0, true)], 1, profile)).toThrow("invalid wall");
    expect(() => historicalWallL2(base, [sample(1000, 0)], 1, { ...profile, id: "e".repeat(64) })).toThrow("settings");
    expect(() => historicalWallL2(base, [sample(2000, 1), sample(1000, 0)], 1, profile)).toThrow("order");
  });
  it("keeps unknown directions out of side models and late prints out of earlier columns without aggregating source trades", () => {
    const result = historicalPrints([print(500, 0), print(700, 1, "UNKNOWN"), print(800, 2, "SELL", 1800)],
      [second(1000), second(2000)], instrument, derivation, ns(2000));
    expect(result.unknownCount).toBe(1);
    expect(result.tape.prints.map((p) => [p.size, p.price, p.side])).toEqual([[1, 100.0001, "buy"], [3, 100.0001, "sell"]]);
    expect(result.tape.clockMs()).toBe(2000);
    expect(result.tape.historical).toBe(true);
    expect(result.seconds[0].column?.prints).toHaveLength(1);
    expect(() => historicalPrints([print(500, 0), print(500, 0)], [], instrument, derivation, ns(2000))).toThrow("order");
    expect(() => historicalPrints([print(1500, 0, "BUY", 2500)], [], instrument, derivation, ns(2000))).toThrow("order");
  });
  it("uses contract notionals and historical freshness without accepting live mutations", () => {
    const seconds = [second(1000)], depth = historicalBookL2(seconds, 0.25, 1), liquidity = historicalBookLiquidity(seconds, 0.25, 1, "contracts");
    const grid = new HistoricalLiquidityGrid(liquidity, depth, instrument);
    expect(grid.clockMs()).toBe(1000);
    expect(grid.baseAsset).toBe("contracts");
    expect(Number.isNaN(grid.columns[0].bid[2])).toBe(true);
    expect(() => grid.apply()).toThrow("immutable");
    const indexed = historicalWallL2(depth, [sample(1000, 0)], 1, profile), store = new WhaleWallStore();
    store.addHistorical(indexed.historicalWalls!(), 0.25, 50);
    const selection = store.select({ cutUsd: 0, fills: true, outcomes: [true, true, true, true, true], side: "both", fromTs: 0,
      bands: { p50: 0, p75: 0, p90: 0, p95: 0, p99: 0 } });
    expect(selection.standing[0].usd).toBe(400000);
  });
});
