import { describe, expect, it } from "vitest";
import {
  computeWhaleTradeStats,
  filterWhaleTradesBySize,
  filterWhaleTradesByTopFraction,
  selectWhaleTradesBySize,
  selectWhaleTradesByTopFraction,
  markerMagnitude,
  type WhaleTradeStat,
  DEFAULT_TOP_FRACTION,
  MIN_TOP_FRACTION,
  MAX_TOP_FRACTION,
  DEFAULT_WHALE_THRESHOLD_CONTRACTS,
  DEFAULT_WHALE_THRESHOLD_USD,
  MAX_WHALE_THRESHOLD_CONTRACTS,
  MAX_WHALE_THRESHOLD_USD,
  MIN_WHALE_THRESHOLD_CONTRACTS,
  MIN_WHALE_THRESHOLD_USD,
} from "../whaleTrades";
import type { MarkerFrame } from "../../../../types/frames";
import { createTimeCoveredMarkerRetentionBuffer } from "../../../chart/markerRetention";

const NOW_MS = 100_000_000;

function marker(notionalUsd: number, tsExchange = NOW_MS, tradeId = `m-${notionalUsd}-${tsExchange}`): MarkerFrame {
  return {
    type: "marker", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", ts_exchange: tsExchange,
    price: 1, size: notionalUsd, side: "buy", trade_id: tradeId,
  };
}

function futuresMarker(contracts: number, tsExchange = NOW_MS, tradeId = `f-${contracts}-${tsExchange}`): MarkerFrame {
  return {
    type: "marker", symbol: "/NQU26:XCME", provider: "DXFEED", assetClass: "FUTURE", ts_exchange: tsExchange,
    price: 29_219, size: contracts, side: "buy", trade_id: tradeId,
  };
}

describe("markerMagnitude", () => {
  it("measures dxFeed futures in contracts, because price is an index point and not a dollar figure", () => {
    expect(markerMagnitude(futuresMarker(40))).toBe(40);
  });

  it("measures archived Databento futures in contracts too", () => {
    expect(markerMagnitude({
      type: "marker", symbol: "ES", provider: "DATABENTO", assetClass: "FUTURE", ts_exchange: NOW_MS,
      price: 6_000, size: 40, side: "buy", trade_id: "es-1",
    })).toBe(40);
  });

  it("measures everything else in notional", () => {
    expect(markerMagnitude(marker(5_000))).toBe(5_000);
    expect(markerMagnitude({
      type: "marker", symbol: "AAPL", provider: "DATABENTO", assetClass: "EQUITY", ts_exchange: NOW_MS,
      price: 250, size: 400, side: "buy", trade_id: "aapl-1",
    })).toBe(100_000);
  });
});

describe("computeWhaleTradeStats", () => {
  it("returns every marker as a candidate -- there is no threshold and no baseline to go degenerate", () => {
    const stats = computeWhaleTradeStats([marker(1), marker(10), marker(1_000_000)], NOW_MS);
    expect(stats.map((s) => s.magnitude)).toEqual([1, 10, 1_000_000]);
  });

  it("excludes markers stamped in the future, which would otherwise render ahead of the last bar", () => {
    const stats = computeWhaleTradeStats([marker(10, NOW_MS), marker(20, NOW_MS + 1)], NOW_MS);
    expect(stats.map((s) => s.magnitude)).toEqual([10]);
  });

  it("drops a marker whose magnitude is not a positive finite number rather than emitting NaN geometry", () => {
    const broken = { ...marker(10), size: Number.NaN };
    expect(computeWhaleTradeStats([broken, marker(10)], NOW_MS)).toHaveLength(1);
  });

  it("rejects an invalid clock instead of silently filtering everything out", () => {
    expect(() => computeWhaleTradeStats([marker(10)], -1)).toThrow(/nowMs/);
    expect(() => computeWhaleTradeStats([marker(10)], 1.5)).toThrow(/nowMs/);
  });
});

describe("filterWhaleTradesBySize", () => {
  const stats = computeWhaleTradeStats([marker(10), marker(100), marker(1_000)], NOW_MS);

  it("keeps trades at or above the chosen size -- inclusive, so the dial's own number qualifies", () => {
    expect(filterWhaleTradesBySize(stats, 100).map((s) => s.magnitude)).toEqual([100, 1_000]);
  });

  it("an upper bound isolates a size class instead of only ever cutting from below", () => {
    expect(filterWhaleTradesBySize(stats, 10, 100).map((s) => s.magnitude)).toEqual([10, 100]);
  });

  it("rejects a non-positive minimum, and a maximum below the minimum", () => {
    expect(() => filterWhaleTradesBySize(stats, 0)).toThrow(/minMagnitude/);
    expect(() => filterWhaleTradesBySize(stats, -5)).toThrow(/minMagnitude/);
    expect(() => filterWhaleTradesBySize(stats, 100, 10)).toThrow(/maxMagnitude/);
  });
});

describe("filterWhaleTradesByTopFraction", () => {
  it("resolves the share against the real tape, not against the markers we happened to retain", () => {
    // 10,000 trades on the tape; only the biggest few ever became markers.
    const stats = computeWhaleTradeStats([marker(10), marker(100), marker(1_000), marker(10_000)], NOW_MS);
    const result = filterWhaleTradesByTopFraction(stats, 10_000, 0.0002);

    expect(result.target).toBe(2);
    expect(result.stats.map((s) => s.magnitude)).toEqual([1_000, 10_000]);
    expect(result.resolvedThreshold).toBe(1_000);
    expect(result.truncated).toBe(false);
    expect(result.effectiveFraction).toBeCloseTo(0.0002, 10);
  });

  it("returns markers in chronological order even though selection is by magnitude", () => {
    const stats = computeWhaleTradeStats([
      marker(10_000, NOW_MS - 3_000, "c"),
      marker(1_000, NOW_MS - 2_000, "b"),
      marker(100_000, NOW_MS - 1_000, "a"),
    ], NOW_MS);
    const result = filterWhaleTradesByTopFraction(stats, 1_000, 0.002);

    expect(result.stats.map((s) => s.marker.trade_id)).toEqual(["c", "a"]);
  });

  it("reports the shortfall instead of pretending, when retention cannot reach the requested depth", () => {
    const stats = computeWhaleTradeStats([marker(10), marker(100)], NOW_MS);
    const result = filterWhaleTradesByTopFraction(stats, 1_000_000, 0.02);

    expect(result.target).toBe(20_000);
    expect(result.stats).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.effectiveFraction).toBeCloseTo(2 / 1_000_000, 12);
  });

  it("a discrete tie mass does not break selection -- /NQ prints are 96% one contract", () => {
    const ones = Array.from({ length: 50 }, (_, i) => futuresMarker(1, NOW_MS - i, `one-${i}`));
    const stats = computeWhaleTradeStats([...ones, futuresMarker(9, NOW_MS, "big")], NOW_MS);
    const result = filterWhaleTradesByTopFraction(stats, 100, 0.01);

    expect(result.stats.map((s) => s.marker.trade_id)).toEqual(["big"]);
    expect(result.resolvedThreshold).toBe(9);
  });

  it("an empty tape shows nothing and claims no coverage", () => {
    const result = filterWhaleTradesByTopFraction([], 0, DEFAULT_TOP_FRACTION);
    expect(result).toEqual({ stats: [], target: 0, truncated: false, effectiveFraction: 0, resolvedThreshold: null });
  });

  it("a non-empty tape always yields at least one marker rather than rounding down to nothing", () => {
    const stats = computeWhaleTradeStats([marker(10)], NOW_MS);
    expect(filterWhaleTradesByTopFraction(stats, 100, MIN_TOP_FRACTION).target).toBe(1);
  });

  it("rejects invalid inputs rather than producing a meaningless threshold", () => {
    expect(() => filterWhaleTradesByTopFraction([], -1, 0.002)).toThrow(/totalTradeCount/);
    expect(() => filterWhaleTradesByTopFraction([], 1.5, 0.002)).toThrow(/totalTradeCount/);
    expect(() => filterWhaleTradesByTopFraction([], 10, 0)).toThrow(/fraction/);
    expect(() => filterWhaleTradesByTopFraction([], 10, 1.5)).toThrow(/fraction/);
  });
});

describe("calibration", () => {
  it("the percentile and contracts defaults sit at the geometric midpoint of their own ranges", () => {
    expect(Math.sqrt(MIN_TOP_FRACTION * MAX_TOP_FRACTION)).toBeCloseTo(DEFAULT_TOP_FRACTION, 12);
    expect(Math.sqrt(MIN_WHALE_THRESHOLD_CONTRACTS * MAX_WHALE_THRESHOLD_CONTRACTS))
      .toBeCloseTo(DEFAULT_WHALE_THRESHOLD_CONTRACTS, 10);
  });

  it("the USD default is a chosen number inside its range, deliberately not the midpoint", () => {
    // $75k was picked directly; with a $20k-$50M range its handle sits left of
    // centre, which is accepted rather than reshaping the range around it.
    expect(DEFAULT_WHALE_THRESHOLD_USD).toBeGreaterThanOrEqual(MIN_WHALE_THRESHOLD_USD);
    expect(DEFAULT_WHALE_THRESHOLD_USD).toBeLessThanOrEqual(MAX_WHALE_THRESHOLD_USD);
  });

  it("the percentile range stops short of the tie mass that makes a coarser cut meaningless", () => {
    // Measured 2026-09-02: top 50%/30% resolve to 1 contract on both /ES and /NQ,
    // i.e. 100% of trades. 2% is the coarsest cut that still discriminates on /NQ.
    expect(MAX_TOP_FRACTION).toBeLessThanOrEqual(0.02);
    expect(MIN_TOP_FRACTION).toBeGreaterThan(0);
  });
});

// Property: selecting from the retention buffer's view gives exactly what the
// array-based functions give over that buffer's own snapshot, in both modes,
// for any threshold or fraction -- so the O(k) path cannot drift from the
// O(n log n) one it replaces. Oracle: the array functions over `snapshot()`,
// which sort the full set from scratch every time.
describe("view-based whale selection equals the array-based oracle", () => {
  const seeded = (seed: number) => {
    let state = seed;
    return () => { state = (state * 1_103_515_245 + 12_345) % 2_147_483_648; return state / 2_147_483_648; };
  };
  const build = (seed: number, count: number, provider: "BINANCE" | "DXFEED") => {
    const random = seeded(seed);
    const buffer = createTimeCoveredMarkerRetentionBuffer(2_000, 60_000, 3);
    const identity = provider === "BINANCE" ? { provider, marketKind: "SPOT" as const } : { provider, assetClass: "FUTURE" as const };
    const batch: MarkerFrame[] = [];
    for (let index = 0; index < count; index += 1) {
      const magnitudeBias = random() < 0.05 ? 50 : 1;
      batch.push({
        type: "marker", symbol: "X", ...identity,
        ts_exchange: 1_700_000_000_000 + Math.floor(index * 7_000 * random()) + index * 100,
        price: 100 + Math.floor(random() * 50), size: Math.ceil(random() * 20) * magnitudeBias,
        side: random() < 0.5 ? "buy" : "sell", trade_id: `t-${seed}-${index}`,
      });
      if (batch.length === 37 || index === count - 1) { buffer.insertAll(batch.splice(0)); }
    }
    return buffer;
  };
  const strip = (stats: WhaleTradeStat[]) => stats.map((stat) => [stat.marker.trade_id, stat.magnitude]);

  it.each([[1, "BINANCE"], [2, "DXFEED"], [3, "BINANCE"]] as const)("seed %i on %s", (seed, provider) => {
    const buffer = build(seed, 6_000, provider);
    const snapshot = buffer.snapshot();
    const oracle = computeWhaleTradeStats(snapshot, Number.MAX_SAFE_INTEGER);
    expect(buffer.size()).toBe(snapshot.length);
    for (const fraction of [0.0000125, 0.0005, 0.01, 0.02, 1]) {
      for (const total of [0, 1, 500, 30_000]) {
        const expected = filterWhaleTradesByTopFraction(oracle, total, fraction);
        const actual = selectWhaleTradesByTopFraction(buffer, total, fraction);
        expect(strip(actual.stats)).toEqual(strip(expected.stats));
        expect({ ...actual, stats: undefined }).toEqual({ ...expected, stats: undefined });
      }
    }
    for (const [min, max] of [[1, null], [50, null], [500, 5_000], [2_000, 2_000], [1e9, null]] as const) {
      expect(strip(selectWhaleTradesBySize(buffer, min, max))).toEqual(strip(filterWhaleTradesBySize(oracle, min, max)));
    }
    expect(() => selectWhaleTradesByTopFraction(buffer, -1, 0.5)).toThrow(/totalTradeCount/);
    expect(() => selectWhaleTradesBySize(buffer, 0)).toThrow(/minMagnitude/);
  });

  it("the selection stays exact after the buffer evicts on the global cap and on full minute buckets", () => {
    const buffer = build(9, 20_000, "BINANCE");
    expect(buffer.size()).toBe(2_000);
    const oracle = computeWhaleTradeStats(buffer.snapshot(), Number.MAX_SAFE_INTEGER);
    expect(strip(selectWhaleTradesByTopFraction(buffer, 40_000, 0.0005).stats))
      .toEqual(strip(filterWhaleTradesByTopFraction(oracle, 40_000, 0.0005).stats));
    expect(strip(selectWhaleTradesBySize(buffer, 700))).toEqual(strip(filterWhaleTradesBySize(oracle, 700)));
    const before = buffer.version;
    expect(buffer.insertAll([buffer.snapshot()[0]])).toBe(false);
    expect(buffer.version).toBe(before);
    expect(buffer.insertAll([{ type: "marker", symbol: "X", provider: "BINANCE", marketKind: "SPOT", ts_exchange: 1_800_000_000_000, price: 1, size: 1, side: "buy", trade_id: "brand-new" }])).toBe(true);
    expect(buffer.version).toBe(before + 1);
  });

  // The magnitude heap deletes lazily: an evicted marker stays in it until the
  // next compaction. This makes the biggest markers the ones that get evicted,
  // with no compaction in between, so a selection that forgot to check liveness
  // would hand back dead giants.
  it("markers evicted while still physically in the magnitude heap are never selected", () => {
    const buffer = createTimeCoveredMarkerRetentionBuffer(200, 60_000, 1);
    const at = (minute: number) => 1_700_000_000_000 + minute * 60_000;
    const mk = (id: string, minute: number, size: number): MarkerFrame =>
      ({ type: "marker", symbol: "X", provider: "BINANCE", marketKind: "SPOT", ts_exchange: at(minute), price: 100, size, side: "buy", trade_id: id });
    const giants = Array.from({ length: 50 }, (_, i) => mk(`giant-${i}`, i, 1_000_000 + i));
    const small = Array.from({ length: 150 }, (_, i) => mk(`small-${i}`, 50 + i, 1 + (i % 9)));
    buffer.insertAll([...giants, ...small]);
    expect(buffer.size()).toBe(200);
    for (let i = 0; i < 50; i += 1) buffer.insertAll([mk(`late-${i}`, 200 + i, 10 + i)]);
    expect(buffer.size()).toBe(200);
    expect(buffer.snapshot().some((marker) => marker.trade_id.startsWith("giant-"))).toBe(false);

    const oracle = computeWhaleTradeStats(buffer.snapshot(), Number.MAX_SAFE_INTEGER);
    const top = selectWhaleTradesByTopFraction(buffer, 20_000, 0.0005);
    expect(top.stats.map((stat) => stat.marker.trade_id)).toEqual(filterWhaleTradesByTopFraction(oracle, 20_000, 0.0005).stats.map((stat) => stat.marker.trade_id));
    expect(top.stats.every((stat) => !stat.marker.trade_id.startsWith("giant-"))).toBe(true);
    expect(top.resolvedThreshold).toBeLessThan(1_000_000);
  });
});
