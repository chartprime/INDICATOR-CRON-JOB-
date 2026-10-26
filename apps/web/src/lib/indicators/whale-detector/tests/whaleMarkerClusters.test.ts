import { describe, expect, it } from "vitest";
import { clusterWhaleMarkers, deltaShareForCluster, displaySizeForCluster, findClusterByIdentity, latestTradeTsForCluster, type WhaleMarkerCluster } from "../whaleMarkerClusters";
import type { WhaleTradeStat } from "../whaleTrades";
import type { MarkerFrame } from "../../../../types/frames";

const ONE_MINUTE_MS = 60_000;

function stat(
  magnitude: number,
  overrides: Partial<MarkerFrame> = {},
): WhaleTradeStat {
  const marker = {
    type: "marker", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT",
    ts_exchange: 90_000, price: 1, size: magnitude, side: "buy", trade_id: `t-${magnitude}`,
    ...overrides,
  } as MarkerFrame;
  return { marker, magnitude: marker.price * marker.size };
}

describe("clusterWhaleMarkers", () => {
  it("keeps two trades on different bars as separate single-trade clusters", () => {
    const clusters = clusterWhaleMarkers(
      [stat(70_000, { ts_exchange: 90_000 }), stat(160_000, { ts_exchange: 200_000 })],
      ONE_MINUTE_MS,
    );
    expect(clusters).toHaveLength(2);
    expect(clusters.every((c) => c.count === 1)).toBe(true);
  });

  it("merges same-side trades sharing a bar into one cluster with the summed notional", () => {
    const clusters = clusterWhaleMarkers(
      [stat(70_000, { ts_exchange: 90_000, side: "buy" }), stat(160_000, { ts_exchange: 95_000, side: "buy" })],
      ONE_MINUTE_MS,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(2);
    expect(clusters[0].magnitude).toBe(230_000);
  });

  it("sums the raw token size (marker.size) across a cluster, independent of notional -- price != 1 proves it isn't just aliasing notionalUsd", () => {
    const clusters = clusterWhaleMarkers(
      [
        stat(0, { ts_exchange: 90_000, side: "buy", price: 50_000, size: 2 }),
        stat(0, { ts_exchange: 95_000, side: "buy", price: 50_000, size: 3.5 }),
      ],
      ONE_MINUTE_MS,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0].sizeTokens).toBe(5.5);
    expect(clusters[0].magnitude).toBe(275_000);
  });

  it("nets a buy and a sell sharing a bar into one cluster instead of two overlapping circles", () => {
    const clusters = clusterWhaleMarkers(
      [stat(70_000, { ts_exchange: 90_000, side: "buy" }), stat(160_000, { ts_exchange: 95_000, side: "sell" })],
      ONE_MINUTE_MS,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0].side).toBe("sell");
    expect(clusters[0].magnitude).toBe(90_000);
    expect(clusters[0].count).toBe(2);
  });

  it("a buy-heavy bar nets to side 'buy' with the notional difference, not the sum", () => {
    const clusters = clusterWhaleMarkers(
      [stat(200_000, { ts_exchange: 90_000, side: "buy" }), stat(80_000, { ts_exchange: 95_000, side: "sell" })],
      ONE_MINUTE_MS,
    );
    expect(clusters[0].side).toBe("buy");
    expect(clusters[0].magnitude).toBe(120_000);
  });

  it("suppresses an exact buy/sell tie because there is no directional net flow", () => {
    const clusters = clusterWhaleMarkers(
      [stat(100_000, { ts_exchange: 90_000, side: "buy" }), stat(100_000, { ts_exchange: 95_000, side: "sell" })],
      ONE_MINUTE_MS,
    );
    expect(clusters).toEqual([]);
  });

  it("sizeTokens on a mixed-side bar is the winning (notional) side's own token total, not a net token difference", () => {
    const clusters = clusterWhaleMarkers(
      [
        stat(0, { ts_exchange: 90_000, side: "buy", price: 50_000, size: 5 }),
        stat(0, { ts_exchange: 95_000, side: "sell", price: 50_000, size: 2 }),
      ],
      ONE_MINUTE_MS,
    );
    expect(clusters[0].side).toBe("buy");
    expect(clusters[0].sizeTokens).toBe(5);
  });

  it("REGRESSION: sizeTokens matches the displayed side even when the losing side contributed more tokens (divergent per-trade prices)", () => {
    // Buy: 50,000 * 3 = 150,000 notional, 3 tokens.
    // Sell: 1,000 * 100 = 100,000 notional, 100 tokens.
    // Net notional favors buy (150k > 100k), so side is "buy" -- but the
    // old net-token-difference computation (|3 - 100| = 97) was almost
    // entirely the SELL side's tokens, contradicting the displayed side.
    const clusters = clusterWhaleMarkers(
      [
        stat(0, { ts_exchange: 90_000, side: "buy", price: 50_000, size: 3 }),
        stat(0, { ts_exchange: 95_000, side: "sell", price: 1_000, size: 100 }),
      ],
      ONE_MINUTE_MS,
    );
    expect(clusters[0].side).toBe("buy");
    expect(clusters[0].magnitude).toBe(50_000);
    expect(clusters[0].sizeTokens).toBe(3);
  });

  it("price still weights across both sides of a mixed bar, not just the winning side", () => {
    const clusters = clusterWhaleMarkers(
      [
        stat(10_000, { ts_exchange: 90_000, side: "buy", price: 100, size: 100 }),
        stat(180_000, { ts_exchange: 95_000, side: "sell", price: 200, size: 900 }),
      ],
      ONE_MINUTE_MS,
    );
    expect(clusters[0].price).toBeCloseTo(194.736842, 5);
  });

  it("the merged cluster's price is the notional-weighted average, not a plain average", () => {
    const clusters = clusterWhaleMarkers(
      [
        stat(100, { ts_exchange: 90_000, side: "buy", price: 100, size: 100 }),
        stat(200, { ts_exchange: 95_000, side: "buy", price: 200, size: 900 }),
      ],
      ONE_MINUTE_MS,
    );
    // notionals are 10_000 (100*100) and 180_000 (200*900) -- weighted toward
    // the much larger second trade, not the plain midpoint of 150.
    expect(clusters[0].price).toBeCloseTo(194.736842, 5);
  });

  it("the cluster's ts is the enclosing bar's open time, matching how the chart buckets trades into candles", () => {
    const clusters = clusterWhaleMarkers([stat(70_000, { ts_exchange: 90_000 })], ONE_MINUTE_MS);
    expect(clusters[0].ts).toBe(60_000);
  });

  it("an empty input returns an empty array", () => {
    expect(clusterWhaleMarkers([], ONE_MINUTE_MS)).toEqual([]);
  });

  it("rejects an invalid interval or cluster mode before bucketing data", () => {
    expect(() => clusterWhaleMarkers([], 0)).toThrow(/intervalMs/);
    expect(() => clusterWhaleMarkers([], ONE_MINUTE_MS, "other" as never)).toThrow(/mode/);
  });

  it("nets a buy and a sell sharing a bar to netted: true -- both sides genuinely contributed", () => {
    const clusters = clusterWhaleMarkers(
      [stat(70_000, { ts_exchange: 90_000, side: "buy" }), stat(160_000, { ts_exchange: 95_000, side: "sell" })],
      ONE_MINUTE_MS,
    );
    expect(clusters[0].netted).toBe(true);
  });

  it("same-side trades sharing a bar in net mode are netted: false -- nothing was actually netted against anything", () => {
    const clusters = clusterWhaleMarkers(
      [stat(70_000, { ts_exchange: 90_000, side: "buy" }), stat(160_000, { ts_exchange: 95_000, side: "buy" })],
      ONE_MINUTE_MS,
    );
    expect(clusters[0].netted).toBe(false);
  });

  it("a single trade in net mode is netted: false", () => {
    const clusters = clusterWhaleMarkers([stat(70_000, { ts_exchange: 90_000 })], ONE_MINUTE_MS);
    expect(clusters[0].netted).toBe(false);
  });
});

describe("clusterWhaleMarkers -- mode: gross", () => {
  it("a buy and a sell sharing a bar produce two separate clusters, not one netted circle", () => {
    const clusters = clusterWhaleMarkers(
      [stat(70_000, { ts_exchange: 90_000, side: "buy" }), stat(160_000, { ts_exchange: 95_000, side: "sell" })],
      ONE_MINUTE_MS,
      "buySell",
    );
    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => c.side).sort()).toEqual(["buy", "sell"]);
  });

  it("each side keeps its own full summed notional, not the net difference", () => {
    const clusters = clusterWhaleMarkers(
      [stat(200_000, { ts_exchange: 90_000, side: "buy" }), stat(80_000, { ts_exchange: 95_000, side: "sell" })],
      ONE_MINUTE_MS,
      "buySell",
    );
    const buyCluster = clusters.find((c) => c.side === "buy")!;
    const sellCluster = clusters.find((c) => c.side === "sell")!;
    expect(buyCluster.magnitude).toBe(200_000);
    expect(sellCluster.magnitude).toBe(80_000);
  });

  it("same-side trades sharing a bar still merge and sum, exactly as in net mode", () => {
    const clusters = clusterWhaleMarkers(
      [stat(70_000, { ts_exchange: 90_000, side: "buy" }), stat(160_000, { ts_exchange: 95_000, side: "buy" })],
      ONE_MINUTE_MS,
      "buySell",
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(2);
    expect(clusters[0].magnitude).toBe(230_000);
  });

  it("a bar with only one side present produces just one cluster, not an empty second one", () => {
    const clusters = clusterWhaleMarkers([stat(70_000, { ts_exchange: 90_000, side: "buy" })], ONE_MINUTE_MS, "buySell");
    expect(clusters).toHaveLength(1);
    expect(clusters[0].side).toBe("buy");
  });

  it("is always netted: false, even when same-side trades merge -- gross mode never nets opposing sides by construction", () => {
    const merged = clusterWhaleMarkers(
      [stat(70_000, { ts_exchange: 90_000, side: "buy" }), stat(160_000, { ts_exchange: 95_000, side: "buy" })],
      ONE_MINUTE_MS,
      "buySell",
    );
    expect(merged[0].netted).toBe(false);

    const opposing = clusterWhaleMarkers(
      [stat(70_000, { ts_exchange: 90_000, side: "buy" }), stat(160_000, { ts_exchange: 95_000, side: "sell" })],
      ONE_MINUTE_MS,
      "buySell",
    );
    expect(opposing.every((c) => c.netted === false)).toBe(true);
  });
});

describe("displaySizeForCluster", () => {
  it("uses net contracts for a mixed-side dxFeed futures bubble, not the full winning-side total", () => {
    const futuresStat = (size: number, side: "buy" | "sell", ts: number): WhaleTradeStat => ({
      marker: {
        type: "marker", symbol: "/NQU26:XCME", provider: "DXFEED", assetClass: "FUTURE",
        ts_exchange: ts, price: 20_000, size, side, trade_id: `future-${side}-${size}-${ts}`,
      },
      magnitude: size,
    });
    const clusters = clusterWhaleMarkers(
      [
        futuresStat(100, "buy", 90_000),
        futuresStat(99, "sell", 95_000),
      ],
      ONE_MINUTE_MS,
    );
    expect(clusters[0].sizeTokens).toBe(100); // winning-side quantity remains available for cash semantics
    expect(clusters[0].magnitude).toBe(1); // dxFeed futures magnitude is contracts
    expect(displaySizeForCluster(clusters[0])).toBe(1);
  });

  it("keeps a cash bubble's winning-side token display, whose token net can disagree with dollar-net direction", () => {
    const clusters = clusterWhaleMarkers(
      [
        stat(0, { ts_exchange: 90_000, price: 50_000, size: 3, side: "buy" }),
        stat(0, { ts_exchange: 95_000, price: 1_000, size: 100, side: "sell" }),
      ],
      ONE_MINUTE_MS,
    );
    expect(displaySizeForCluster(clusters[0])).toBe(3);
  });
});

function cluster(overrides: Partial<WhaleMarkerCluster>): WhaleMarkerCluster {
  return {
    ts: 0, side: "buy", price: 1, magnitude: 0, sizeTokens: 0, count: 0, stats: [], netted: false,
    ...overrides,
  };
}

describe("latestTradeTsForCluster", () => {
  it("REGRESSION: returns the actual trade time, not the cluster's own bucket-open time -- on a coarse display timeframe these are very different", () => {
    // A 1-hour candle: the bucket opens at 10:00:00, but the trade
    // actually happened at 10:47:00 -- cluster.ts (10:00:00) would anchor
    // a trailing 5-minute window at 09:55-10:00, entirely missing the
    // real 47 minutes of context leading up to the trade.
    const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
    const tradeAt1047 = 10 * ONE_HOUR_MS + 47 * ONE_MINUTE_MS;
    const clusters = clusterWhaleMarkers([stat(70_000, { ts_exchange: tradeAt1047 })], ONE_HOUR_MS);
    expect(clusters[0].ts).toBe(10 * ONE_HOUR_MS); // the bucket open, per the existing "cluster.ts" test
    expect(latestTradeTsForCluster(clusters[0])).toBe(tradeAt1047);
  });

  it("returns the most recent of several trades merged into one cluster, not the first or the bucket time", () => {
    const clusters = clusterWhaleMarkers(
      [
        stat(70_000, { ts_exchange: 90_000, side: "buy" }),
        stat(80_000, { ts_exchange: 95_000, side: "buy" }),
        stat(60_000, { ts_exchange: 93_000, side: "buy" }),
      ],
      ONE_MINUTE_MS,
    );
    expect(latestTradeTsForCluster(clusters[0])).toBe(95_000);
  });
});

describe("findClusterByIdentity", () => {
  it("REGRESSION: finds a cluster still present in a new list by ts+side, so a hovered tooltip can survive an unrelated snapshot update", () => {
    const hoveredBefore = cluster({ ts: 60_000, side: "buy", magnitude: 100 });
    const sameIdentityAfterUpdate = cluster({ ts: 60_000, side: "buy", magnitude: 250 });
    const unrelated = cluster({ ts: 120_000, side: "sell", magnitude: 999 });
    const found = findClusterByIdentity([unrelated, sameIdentityAfterUpdate], hoveredBefore.ts, hoveredBefore.side);
    expect(found).toBe(sameIdentityAfterUpdate);
  });

  it("returns null when no cluster in the list matches the given ts+side", () => {
    const unrelated = cluster({ ts: 120_000, side: "sell" });
    expect(findClusterByIdentity([unrelated], 60_000, "buy")).toBeNull();
  });

  it("does not match on ts alone or side alone -- both must agree", () => {
    const wrongSide = cluster({ ts: 60_000, side: "sell" });
    const wrongTs = cluster({ ts: 120_000, side: "buy" });
    expect(findClusterByIdentity([wrongSide, wrongTs], 60_000, "buy")).toBeNull();
  });
});

describe("deltaShareForCluster", () => {
  it("is 1 for a one-sided cluster -- all of its size is net", () => {
    const clusters = clusterWhaleMarkers([stat(70_000, { ts_exchange: 90_000, side: "buy" })], ONE_MINUTE_MS, "delta");
    expect(deltaShareForCluster(clusters[0])).toBeCloseTo(1, 10);
  });

  it("falls toward 0 as buying and selling cancel, which is what Min delta filters on", () => {
    const clusters = clusterWhaleMarkers(
      [
        stat(100_000, { ts_exchange: 90_000, side: "buy", trade_id: "b" }),
        stat(90_000, { ts_exchange: 91_000, side: "sell", trade_id: "s" }),
      ],
      ONE_MINUTE_MS,
      "delta",
    );
    // net 10k of 190k gross
    expect(deltaShareForCluster(clusters[0])).toBeCloseTo(10_000 / 190_000, 10);
  });
});
